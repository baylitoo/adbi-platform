#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_cv_parser_runner.py -- executed INSIDE the adbi-cv-parser container by
compare_pipelines.py (via `docker exec`), never on its own. Imports app.py
and calls process_cv(...) directly -- the real in-process extraction path,
no Flask/HTTP involved -- and writes the result as JSON to a file so the
caller can read it back without app.py's own [INFO]/[PERF] prints (written
to stdout during process_cv) polluting the JSON.

Usage (inside the container):
    python /app/_cv_parser_runner.py <input_file> <output_json_path>
"""
from __future__ import annotations

import json
import sys
import time


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: _cv_parser_runner.py <input_file> <output_json_path>", file=sys.stderr)
        return 2
    input_path, output_path = sys.argv[1], sys.argv[2]

    sys.path.insert(0, "/app")
    from app import process_cv  # the real pipeline entry point

    t0 = time.perf_counter()
    data = process_cv(input_path)
    data["_wall_s"] = round(time.perf_counter() - t0, 3)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, default=str)
    print(f"[_cv_parser_runner] wrote {output_path} in {data['_wall_s']}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
