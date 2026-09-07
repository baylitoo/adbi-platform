"""Query a remote chat endpoint or DocIE extraction using an env file.

python scripts/query_remote.py chat --env .env.remote
python scripts/query_remote.py extract cv.pdf --env .env.remote
Requires requests (already a CV Parser dependency).
"""
import argparse
import json
import os
from pathlib import Path
import sys
import time

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cv-parser"))
from docie_client import DocIEError, extract_resume
from llm_url import chat_endpoint


def load_env(path):
    # Simple KEY=value file; whole-line comments and quoted values supported.
    # Explicit file values take precedence over the invoking shell.
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator:
            raise ValueError("Environment file must contain KEY=value lines.")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key.strip().startswith(("ADBI_LLM_", "DOCIE_")):
            os.environ[key.strip()] = value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("chat", "extract"))
    parser.add_argument("file", nargs="?", type=Path)
    parser.add_argument("--env", type=Path, default=ROOT / ".env.remote")
    parser.add_argument("--prompt", default="Reply with a JSON object containing ok: true.")
    args = parser.parse_args()
    if args.mode == "extract" and args.file is None:
        parser.error("extract requires a PDF or DOCX file")
    started = time.monotonic()
    try:
        load_env(args.env)
        if args.mode == "extract":
            # Accept the API root or the full Studio extraction endpoint.
            base = os.environ.get("DOCIE_BASE_URL", "").rstrip("/")
            for suffix in ("/v1/studio/extract", "/v1/studio"):
                if base.endswith(suffix):
                    base = base[:-len(suffix)]
                    break
            os.environ["DOCIE_BASE_URL"] = base
            data, metadata = extract_resume(args.file)
            result = {"cv": data, "docie": metadata}
        else:
            model = os.environ.get("ADBI_LLM_MODEL", "").strip()
            if not model:
                raise ValueError("Set ADBI_LLM_MODEL to the model ID served by the endpoint.")
            headers = {}
            if os.environ.get("ADBI_LLM_API_KEY"):
                headers["Authorization"] = "Bearer " + os.environ["ADBI_LLM_API_KEY"]
            response = requests.post(
                chat_endpoint(os.environ.get("ADBI_LLM_BASE_URL", "")),
                headers=headers, timeout=60, allow_redirects=False,
                json={"model": model, "messages": [{"role": "user", "content": args.prompt}],
                      "max_tokens": 256, "temperature": 0, "stream": False},
            )
            if not 200 <= response.status_code < 300:
                raise ValueError(f"Remote endpoint returned HTTP {response.status_code}.")
            result = response.json()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print(f"Elapsed: {time.monotonic() - started:.1f}s", file=sys.stderr)
        return 0
    except requests.RequestException:
        print("Connection/TLS error or request timeout. Check the endpoint and network.", file=sys.stderr)
    except (DocIEError, ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
