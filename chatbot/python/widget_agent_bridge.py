#!/usr/bin/env python3
"""stdin/stdout JSON bridge for n8n AI widget agent pipelines."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

JSONDict = Dict[str, Any]


def _chatbot_root() -> Path:
    """…/chatbot/python/thisfile → chatbot package root."""
    return Path(__file__).resolve().parent.parent


def _bundles_dir() -> Path:
    return _chatbot_root() / "bundles"


def _bundle_path(env_key: str, subdir: str) -> Path:
    """
    Resolve bundle root. Override with env (absolute path), else ``chatbot/bundles/<subdir>``.
    """
    raw = os.environ.get(env_key) or ""
    if raw:
        return Path(raw)
    return _bundles_dir() / subdir


def _setup_modify_path() -> None:
    root = _bundle_path("WIDGET_MODIFY_BUNDLE", "modify")
    s = str(root.resolve())
    if s not in sys.path:
        sys.path.insert(0, s)


def _setup_delete_path() -> None:
    root = _bundle_path("WIDGET_DELETE_BUNDLE", "delete")
    s = str(root.resolve())
    if s not in sys.path:
        sys.path.insert(0, s)


def _setup_insert_path() -> None:
    root = _bundle_path("WIDGET_INSERT_BUNDLE", "insert")
    s = str(root.resolve())
    if s not in sys.path:
        sys.path.insert(0, s)


def _setup_decompose_path() -> None:
    root = _bundle_path("WIDGET_DECOMPOSE_DIR", "decompose")
    s = str(root.resolve())
    if s not in sys.path:
        sys.path.insert(0, s)


def cmd_decompose(payload: JSONDict) -> JSONDict:
    _setup_decompose_path()
    from decompose_pipeline import decompose_widget_turn

    query = str(payload.get("query") or "")
    qa = payload.get("qa_pairs")
    if qa is not None and not (
        isinstance(qa, list) and all(isinstance(x, dict) for x in qa)
    ):
        return {"ok": False, "error": "invalid qa_pairs"}
    api_key = payload.get("api_key") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return {"ok": False, "error": "OPENAI_API_KEY missing"}
    out = decompose_widget_turn(query, qa_pairs=qa, api_key=str(api_key))
    return {"ok": True, "result": out}


def cmd_modify(payload: JSONDict) -> JSONDict:
    _setup_modify_path()
    _py_dir = str(Path(__file__).resolve().parent)
    if _py_dir not in sys.path:
        sys.path.insert(0, _py_dir)
    from modify_pipeline.pipeline import TwoPhaseConfig, run_two_phase_modification

    wf = payload.get("workflow")
    if not isinstance(wf, dict):
        return {"ok": False, "error": "workflow object required"}
    instruction = str(payload.get("instruction") or "")
    model = str(payload.get("model") or "gpt-4o")
    api_key = str(payload.get("api_key") or os.environ.get("OPENAI_API_KEY") or "")
    if not api_key:
        return {"ok": False, "error": "OPENAI_API_KEY missing"}
    base_url = payload.get("base_url") or os.environ.get("OPENAI_BASE_URL") or None
    cns = payload.get("confirmed_node_names")
    confirmed: Optional[List[str]] = None
    if isinstance(cns, list):
        confirmed = [str(x) for x in cns if isinstance(x, str) and x.strip()]
        if not confirmed:
            confirmed = None

    cfg = TwoPhaseConfig(
        model=model,
        api_key=api_key,
        base_url=str(base_url) if base_url else None,
    )
    result = run_two_phase_modification(
        wf,
        instruction,
        config=cfg,
        confirmed_node_names=confirmed,
    )
    return {"ok": True, "result": result}


def cmd_delete(payload: JSONDict) -> JSONDict:
    # Both bundles on path; last insert(0) is ``modify``, so order is [modify, delete].
    # ``delete_pipeline`` imports ``modify_pipeline`` — modify root must come first.
    _setup_delete_path()
    _setup_modify_path()

    wf = payload.get("workflow")
    if not isinstance(wf, dict):
        return {"ok": False, "error": "workflow object required"}
    instruction = str(payload.get("instruction") or "")
    model = str(payload.get("model") or "gpt-4o")
    api_key = str(payload.get("api_key") or os.environ.get("OPENAI_API_KEY") or "")
    if not api_key:
        return {"ok": False, "error": "OPENAI_API_KEY missing"}
    base_url = payload.get("base_url") or os.environ.get("OPENAI_BASE_URL") or None
    cns = payload.get("confirmed_node_names")
    confirmed: Optional[List[str]] = None
    if isinstance(cns, list):
        confirmed = [str(x) for x in cns if isinstance(x, str) and x.strip()]
        if not confirmed:
            confirmed = None

    from modify_pipeline.pipeline import TwoPhaseConfig
    from delete_pipeline.pipeline import run_deletion

    cfg = TwoPhaseConfig(
        model=model,
        api_key=api_key,
        base_url=str(base_url) if base_url else None,
    )
    result = run_deletion(
        wf,
        instruction,
        config=cfg,
        confirmed_node_names=confirmed,
        simulate_deletion_interaction=True,
    )
    return {"ok": True, "result": result}


def cmd_insert(payload: JSONDict) -> JSONDict:
    _setup_insert_path()
    _script_dir = str(Path(__file__).resolve().parent)
    if _script_dir not in sys.path:
        sys.path.insert(0, _script_dir)
    from insert_runner_widget import run_insert_widget

    wf = payload.get("workflow")
    if not isinstance(wf, dict):
        return {"ok": False, "error": "workflow object required"}
    instruction = str(payload.get("instruction") or "")
    model = str(payload.get("model") or "gpt-4o")
    api_key = str(payload.get("api_key") or os.environ.get("OPENAI_API_KEY") or "")
    if not api_key:
        return {"ok": False, "error": "OPENAI_API_KEY missing"}
    base_url = payload.get("base_url") or os.environ.get("OPENAI_BASE_URL") or None
    out = run_insert_widget(
        wf,
        instruction,
        model=model,
        api_key=api_key,
        base_url=str(base_url) if base_url else None,
    )
    return {"ok": True, "result": out}


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"ok": False, "error": "empty stdin"}))
        sys.exit(1)
    try:
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"invalid json: {e}"}))
        sys.exit(1)
    command = str(req.get("command") or "")
    payload = req.get("payload") if isinstance(req.get("payload"), dict) else {}

    try:
        if command == "decompose":
            out = cmd_decompose(payload)
        elif command == "modify":
            out = cmd_modify(payload)
        elif command == "delete":
            out = cmd_delete(payload)
        elif command == "insert":
            out = cmd_insert(payload)
        else:
            out = {"ok": False, "error": f"unknown command: {command}"}
    except Exception as e:
        import traceback
        out = {"ok": False, "error": str(e), "traceback": traceback.format_exc()}

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
