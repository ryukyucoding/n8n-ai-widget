#!/usr/bin/env python3
"""CLI for staged creation benchmark runs (stdin JSON → stdout JSON)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "chatbot" / "bundles" / "create"))
sys.path.insert(0, str(REPO_ROOT / "chatbot" / "bundles" / "modify"))

from create_pipeline.pipeline import StagedCreateConfig, run_staged_creation  # noqa: E402


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"ok": False, "error": "empty stdin"}))
        sys.exit(1)
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"invalid json: {e}"}))
        sys.exit(1)

    instruction = str(req.get("instruction") or "").strip()
    if not instruction:
        print(json.dumps({"ok": False, "error": "instruction required"}))
        sys.exit(1)

    api_key = str(req.get("api_key") or os.environ.get("OPENAI_API_KEY") or "")
    cfg = StagedCreateConfig(
        model=str(req.get("model") or os.environ.get("OPENAI_MODEL") or "gpt-4.1"),
        api_key=api_key,
        base_url=req.get("base_url") or os.environ.get("OPENAI_BASE_URL") or None,
        temperature=float(req.get("temperature") or 0),
        max_fix_iterations=int(req.get("max_fix_iterations") or 1),
        skip_param_fill=bool(req.get("skip_param_fill")),
    )
    out = run_staged_creation(instruction, cfg)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
