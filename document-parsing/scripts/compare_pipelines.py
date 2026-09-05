#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""compare_pipelines.py -- runs the same sample CV documents through BOTH
cv-parser's real extraction path (Docling + llm_cascade.py, called
in-process, not over HTTP) and a real DocIE Studio instance
(/v1/studio/extract, "resume" dynamic schema, polled to completion), and
produces a field-by-field comparison.

This is the deliverable for the cv-parser-vs-DocIE pipeline comparison
(see the PR body for the real results and findings). Companion pieces:
  - generate_sample_cvs.py  -- produces the 3 fixture PDFs this script reads
  - register_and_test.py    -- PR #46's original DocIE smoke test; this
    script reuses its trigger/poll pattern (POST /v1/studio/extract,
    GET /v1/studio/runs/{event_id}) but adds real content_b64 file upload
    (not just raw text) and unwraps DocIE's evidence-grounded field envelope
    ({"value":..., "confidence":..., "evidence_ids":[...]}) into plain
    values for comparison.
  - _cv_parser_runner.py    -- tiny script `docker cp`'d into the running
    adbi-cv-parser container and `docker exec`'d, so cv-parser's own
    process_cv() runs in ITS real environment (Docling installed, real
    Docker image) without needing Docling/torch installed on this host.

Environment assumptions (see the PR body for exactly how this was stood up
in-session): a DocIE Studio api reachable at DOCIE_BASE_URL with the
"resume" schema already registered (register_and_test.py --schemas-only),
and a running `adbi-cv-parser` container (CONTAINER_NAME) with this repo's
current cv-parser/*.py copied in via `docker cp` (so it runs the SAME code
as this checkout, not whatever was baked into the image at build time).

Usage:
    python compare_pipelines.py [--samples simple,dense,scanned]
                                 [--docie-timeout-s 900]
                                 [--skip-docie] [--skip-cv-parser]
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent  # document-parsing/
FIXTURES_DIR = REPO_ROOT / "fixtures" / "cv_samples"
RESULTS_DIR = FIXTURES_DIR / "results"

CONTAINER_NAME = "adbi-cv-parser"
RUNNER_IN_CONTAINER = "/app/_cv_parser_runner.py"

DOCIE_BASE_URL = "http://127.0.0.1:8080"
DOCIE_SCHEMA_NAME = "resume"
DOCIE_MODEL_PROFILE = "nuextract3_local_127"  # see configs/models.yaml in the
# DocIE checkout -- NuExtract3 (nuextract:3.8b) via a local Ollama install,
# pinned to 127.0.0.1 (see PR body: "localhost" hung indefinitely for
# SQLAlchemy/httpx on this host). NOT DocIE's own managed llama-server
# serving control plane -- see the PR body for why, and for the caveat this
# implies on the results below.

SAMPLES = {
    "simple": FIXTURES_DIR / "cv_simple.pdf",
    "dense": FIXTURES_DIR / "cv_dense.pdf",
    "scanned": FIXTURES_DIR / "cv_scanned.pdf",
}


# ---------------------------------------------------------------------------
# cv-parser side: docker cp the file in, docker exec the real process_cv(),
# docker cp the JSON result back out. No Flask/HTTP involved.
# ---------------------------------------------------------------------------
def run_cv_parser(sample_name: str, path: Path) -> dict[str, Any]:
    remote_in = f"/tmp/compare_{sample_name}{path.suffix}"
    remote_out = f"/tmp/compare_{sample_name}_out.json"
    local_out = RESULTS_DIR / f"{sample_name}_cv_parser.json"

    subprocess.run(
        ["docker", "cp", str(path), f"{CONTAINER_NAME}:{remote_in}"],
        check=True, capture_output=True,
    )
    t0 = time.perf_counter()
    proc = subprocess.run(
        ["docker", "exec", CONTAINER_NAME, "python", RUNNER_IN_CONTAINER, remote_in, remote_out],
        capture_output=True, text=True, timeout=300,
    )
    wall_s = time.perf_counter() - t0
    print(f"[cv-parser][{sample_name}] exit={proc.returncode} wall={wall_s:.1f}s")
    if proc.stderr:
        print(f"[cv-parser][{sample_name}] stderr tail:\n" + "\n".join(proc.stderr.splitlines()[-15:]))
    if proc.returncode != 0:
        result = {"_error": "process_cv failed", "_returncode": proc.returncode,
                  "_stderr": proc.stderr[-4000:]}
        local_out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return result

    subprocess.run(
        ["docker", "cp", f"{CONTAINER_NAME}:{remote_out}", str(local_out)],
        check=True, capture_output=True,
    )
    return json.loads(local_out.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# DocIE side: real content_b64 upload + dynamic_schema_name=resume, polled to
# completion via the durable extraction-result path (server-integration.md's
# reference client, adapted from register_and_test.py).
# ---------------------------------------------------------------------------
def run_docie(sample_name: str, path: Path, timeout_s: int) -> dict[str, Any]:
    local_out = RESULTS_DIR / f"{sample_name}_docie.json"
    content_b64 = base64.b64encode(path.read_bytes()).decode()
    payload = {
        "content_b64": content_b64,
        "filename": path.name,
        "dynamic_schema_name": DOCIE_SCHEMA_NAME,
        "model_profile": DOCIE_MODEL_PROFILE,
    }
    t0 = time.perf_counter()
    trigger = requests.post(f"{DOCIE_BASE_URL}/v1/studio/extract", json=payload, timeout=30)
    trigger.raise_for_status()
    event_id = trigger.json()["event_ids"][0]
    print(f"[docie][{sample_name}] triggered event_id={event_id}")

    deadline = time.monotonic() + timeout_s
    last_status = None
    while time.monotonic() < deadline:
        try:
            r = requests.get(f"{DOCIE_BASE_URL}/v1/studio/runs/{event_id}", timeout=15)
        except requests.exceptions.RequestException as exc:
            print(f"[docie][{sample_name}] poll error (continuing): {exc}")
            time.sleep(10)
            continue
        if r.status_code != 200:
            time.sleep(10)
            continue
        payload = r.json()
        # Durable (completed) path returns a bare list [{...}]. The
        # still-running fallback proxies Inngest's own REST API verbatim,
        # which wraps rows in {"data": [...]} -- see register_and_test.py's
        # original run_extraction() for this exact same shape distinction.
        if isinstance(payload, dict):
            rows = payload.get("data") or []
        else:
            rows = payload or []
        row = rows[0] if rows else {}
        status = row.get("status")
        if status != last_status:
            print(f"[docie][{sample_name}] status={status} ({time.perf_counter()-t0:.0f}s elapsed)")
            last_status = status
        if row.get("output") is not None:
            wall_s = time.perf_counter() - t0
            print(f"[docie][{sample_name}] DONE in {wall_s:.1f}s")
            result = row["output"]
            result["_wall_s"] = wall_s
            local_out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            return result
        if status in ("Failed", "failed"):
            result = {"_error": "extraction failed", "_row": row}
            local_out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            return result
        time.sleep(10)

    result = {"_error": f"did not complete within {timeout_s}s", "event_id": event_id}
    local_out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[docie][{sample_name}] TIMEOUT after {timeout_s}s (event_id={event_id} -- "
          f"may still complete later; re-poll GET /v1/studio/runs/{event_id})")
    return result


# ---------------------------------------------------------------------------
# Unwrap DocIE's evidence-grounded field envelope into plain values.
# Every scalar leaf is {"value": ..., "confidence": float, "evidence_ids": [...]}
# (money fields: {"amount":..., "currency":..., "confidence":...}) -- see
# docie_bench/schemas/common.py + schemas/dynamic.py's DynamicTemplateBuilder.
# object fields are a plain dict of such leaves; list fields are a plain list
# of such dicts. Recursing generically here handles all of it.
# ---------------------------------------------------------------------------
def _is_leaf_field(node: dict) -> bool:
    keys = set(node.keys())
    return keys <= {"value", "confidence", "evidence_ids"} and "value" in keys \
        or keys <= {"amount", "currency", "confidence"} and "amount" in keys


def unwrap_docie(node: Any) -> Any:
    if isinstance(node, dict):
        if _is_leaf_field(node):
            if "value" in node:
                return node.get("value")
            amount, currency = node.get("amount"), node.get("currency")
            return f"{amount} {currency}".strip() if amount is not None else None
        return {k: unwrap_docie(v) for k, v in node.items() if k != "document_type"}
    if isinstance(node, list):
        return [unwrap_docie(v) for v in node]
    return node


# ---------------------------------------------------------------------------
# Normalize both pipelines' output into one common comparable shape.
# ---------------------------------------------------------------------------
def normalize_cv_parser(raw: dict[str, Any]) -> dict[str, Any]:
    if "_error" in raw:
        return {"_error": raw["_error"]}
    contact = raw.get("contact") or {}
    return {
        "name": raw.get("name") or "",
        "title": raw.get("title") or "",
        "email": contact.get("email") or "",
        "phone": contact.get("phone") or "",
        "linkedin": contact.get("linkedin") or "",
        "location": contact.get("location") or "",
        "experience": [
            {
                "company": e.get("company") or "",
                "title": e.get("title") or "",
                "period": e.get("period") or "",
                "env_technique": e.get("env_technique") or "",
                "description": e.get("description") or "",
            }
            for e in (raw.get("experience") or [])
        ],
        "education": [
            {
                "degree": e.get("title") or "",
                "institution": e.get("subtitle") or "",
                "period": e.get("period") or "",
            }
            for e in (raw.get("education") or [])
        ],
        "skills": sorted({
            item
            for cat in (raw.get("skills") or [])
            for item in (cat.get("items") or [])
        }),
        "languages": [
            {"language": l.get("language") or "", "level": l.get("level") or ""}
            for l in (raw.get("languages") or [])
        ],
        "_meta": {
            "llm_parsed": raw.get("llm_parsed"),
            "docling_used": raw.get("docling_used"),
            "parsing_mode": raw.get("parsing_mode"),
            "wall_s": raw.get("_wall_s"),
        },
    }


def normalize_docie(raw: dict[str, Any]) -> dict[str, Any]:
    if "_error" in raw:
        return {"_error": raw["_error"]}
    result = unwrap_docie(raw.get("result") or {})
    contact = result.get("contact") or {}
    skills_flat: set[str] = set()
    for cat in (result.get("skills") or []):
        for item in (cat.get("items") or []):
            val = item.get("item") if isinstance(item, dict) else item
            if val:
                skills_flat.add(val)
    return {
        "name": result.get("name") or "",
        "title": result.get("title") or "",
        "email": contact.get("email") or "",
        "phone": contact.get("phone") or "",
        "linkedin": contact.get("linkedin") or "",
        "location": contact.get("location") or "",
        "experience": [
            {
                "company": e.get("company") or "",
                "title": e.get("title") or "",
                "period": f"{e.get('start_date') or ''} - {e.get('end_date') or ''}".strip(" -"),
                "env_technique": e.get("env_technique") or "",
                "description": e.get("description") or "",
            }
            for e in (result.get("experience") or [])
        ],
        "education": [
            {
                "degree": e.get("degree") or "",
                "institution": e.get("institution") or "",
                "period": e.get("year") or "",
            }
            for e in (result.get("education") or [])
        ],
        "skills": sorted(skills_flat),
        "languages": [
            {"language": l.get("language") or "", "level": l.get("level") or ""}
            for l in (result.get("languages") or [])
        ],
        "_meta": {
            "model_profile": raw.get("model_profile"),
            "latency_ms": raw.get("latency_ms"),
            "validation": raw.get("validation"),
            "wall_s": raw.get("_wall_s"),
        },
    }


def _norm_text(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def compare_field(label: str, a: str, b: str) -> dict[str, Any]:
    na, nb = _norm_text(a), _norm_text(b)
    if not na and not nb:
        verdict = "both_empty"
    elif na and nb and na == nb:
        verdict = "agree"
    elif na and nb:
        verdict = "disagree"
    elif na and not nb:
        verdict = "cv_parser_only"
    else:
        verdict = "docie_only"
    return {"field": label, "cv_parser": a, "docie": b, "verdict": verdict}


def compare(cv: dict[str, Any], docie: dict[str, Any]) -> dict[str, Any]:
    if "_error" in cv or "_error" in docie:
        return {"cv_parser_error": cv.get("_error"), "docie_error": docie.get("_error")}

    fields = []
    for f in ("name", "title", "email", "phone", "linkedin", "location"):
        fields.append(compare_field(f, cv.get(f, ""), docie.get(f, "")))

    n_exp = max(len(cv["experience"]), len(docie["experience"]))
    for i in range(n_exp):
        ce = cv["experience"][i] if i < len(cv["experience"]) else {}
        de = docie["experience"][i] if i < len(docie["experience"]) else {}
        for f in ("company", "title", "period", "env_technique", "description"):
            fields.append(compare_field(f"experience[{i}].{f}", ce.get(f, ""), de.get(f, "")))

    n_edu = max(len(cv["education"]), len(docie["education"]))
    for i in range(n_edu):
        ce = cv["education"][i] if i < len(cv["education"]) else {}
        de = docie["education"][i] if i < len(docie["education"]) else {}
        for f in ("degree", "institution", "period"):
            fields.append(compare_field(f"education[{i}].{f}", ce.get(f, ""), de.get(f, "")))

    cv_skills, docie_skills = set(cv["skills"]), set(docie["skills"])
    if not cv_skills and not docie_skills:
        skills_verdict = "both_empty"
    elif cv_skills == docie_skills:
        skills_verdict = "agree"
    elif not cv_skills:
        skills_verdict = "docie_only"
    elif not docie_skills:
        skills_verdict = "cv_parser_only"
    else:
        skills_verdict = "disagree"
    fields.append({
        "field": "skills (set)",
        "cv_parser": sorted(cv_skills),
        "docie": sorted(docie_skills),
        "verdict": skills_verdict,
        "cv_parser_only_items": sorted(cv_skills - docie_skills),
        "docie_only_items": sorted(docie_skills - cv_skills),
    })

    counts: dict[str, int] = {}
    for f in fields:
        counts[f["verdict"]] = counts.get(f["verdict"], 0) + 1

    return {"fields": fields, "counts": counts}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", default="simple,dense,scanned")
    ap.add_argument("--docie-timeout-s", type=int, default=900)
    ap.add_argument("--skip-docie", action="store_true")
    ap.add_argument("--skip-cv-parser", action="store_true")
    args = ap.parse_args()

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    names = [s.strip() for s in args.samples.split(",") if s.strip()]

    summary: dict[str, Any] = {}
    for name in names:
        path = SAMPLES[name]
        print(f"\n=== {name} ({path.name}) ===")

        if args.skip_cv_parser:
            cv_raw = json.loads((RESULTS_DIR / f"{name}_cv_parser.json").read_text(encoding="utf-8"))
        else:
            cv_raw = run_cv_parser(name, path)

        if args.skip_docie:
            docie_path = RESULTS_DIR / f"{name}_docie.json"
            docie_raw = json.loads(docie_path.read_text(encoding="utf-8")) if docie_path.exists() else {"_error": "skipped"}
        else:
            docie_raw = run_docie(name, path, args.docie_timeout_s)

        cv_norm = normalize_cv_parser(cv_raw)
        docie_norm = normalize_docie(docie_raw)
        cmp_result = compare(cv_norm, docie_norm)

        out = {"cv_parser": cv_norm, "docie": docie_norm, "comparison": cmp_result}
        (RESULTS_DIR / f"{name}_comparison.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        summary[name] = cmp_result.get("counts", cmp_result)
        print(f"[{name}] verdict counts: {cmp_result.get('counts', cmp_result)}")

    print("\n=== SUMMARY ===")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
