#!/usr/bin/env python3
"""CLI: repair a pred workflow from execution/validation errors (stdin JSON → stdout JSON)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "chatbot" / "python"))
sys.path.insert(0, str(REPO_ROOT / "chatbot" / "bundles" / "modify"))

from repair_runner import run_repair_widget  # noqa: E402


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

    workflow = req.get("workflow")
    if not isinstance(workflow, dict):
        print(json.dumps({"ok": False, "error": "workflow object required"}))
        sys.exit(1)

    api_key = str(req.get("api_key") or os.environ.get("OPENAI_API_KEY") or "")
    out = run_repair_widget(
        workflow,
        error_context=req.get("error_context"),
        user_query=str(req.get("user_query") or req.get("instruction") or "Auto-repair benchmark pred"),
        validation_issues=req.get("validation_issues"),
        prior_signatures=req.get("prior_signatures") or [],
        iteration=int(req.get("iteration") or 1),
        repeat_threshold=int(req.get("repeat_threshold") or 2),
        model=str(req.get("model") or os.environ.get("OPENAI_MODEL") or "gpt-4o"),
        api_key=api_key,
        base_url=req.get("base_url") or os.environ.get("OPENAI_BASE_URL") or None,
        skip_llm=bool(req.get("skip_llm")),
    )
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
