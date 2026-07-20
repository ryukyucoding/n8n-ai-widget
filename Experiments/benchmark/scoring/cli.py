#!/usr/bin/env python3
"""Unified CLI for creation benchmark scoring."""

from __future__ import annotations

import sys
from pathlib import Path

BENCHMARK_ROOT = Path(__file__).resolve().parent.parent
if str(BENCHMARK_ROOT) not in sys.path:
    sys.path.insert(0, str(BENCHMARK_ROOT))


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in {"-h", "--help"}:
        print(
            """Usage:
  python scoring/cli.py create --gold GOLD.json --pred PRED.json [--out score.json]
  python scoring/cli.py edit   --operation delete|insert|modify \\
         --base BASE.json --gold GOLD.json --pred PRED.json [--case-json case.json]

Examples:
  python scoring/cli.py create --gold data/creation/create-001/gold.json --pred pred.json
  python scoring/cli.py edit --operation delete \\
         --base data/creation_edit/delete/create-del-001/base.json \\
         --gold data/creation_edit/delete/create-del-001/gold.json \\
         --pred pred.json
"""
        )
        return 0

    cmd = sys.argv[1]
    rest = sys.argv[2:]

    if cmd == "create":
        from scoring.score_create import main as create_main

        return create_main(rest)
    if cmd == "edit":
        from scoring.score_edit import main as edit_main

        return edit_main(rest)

    print(f"Unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
