#!/usr/bin/env python3
"""Run Delete benchmark cases through the deployed chatbot container.

This intentionally calls the same Python bridge used by the chatbot, but never
contacts n8n or writes a workflow back to n8n.  It is therefore safe for batch
benchmarking production-like model routing.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def case_number(path: Path) -> int:
    try:
        return int(path.name.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return sys.maxsize


def run_bridge(*, container: str, envelope: dict[str, Any], timeout: int) -> dict[str, Any]:
    completed = subprocess.run(
        ["docker", "exec", "-i", container, "python3", "/app/python/widget_agent_bridge.py"],
        input=json.dumps(envelope, ensure_ascii=False),
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    raw = completed.stdout.strip()
    try:
        bridge = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        bridge = None
    return {
        "exit_code": completed.returncode,
        "stdout": raw,
        "stderr": completed.stderr.strip(),
        "bridge": bridge,
    }


def main() -> int:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Run Delete benchmark through n8n-chatbot container")
    parser.add_argument("--container", default="n8n-chatbot-1")
    parser.add_argument("--model", default="gpt-oss:120b")
    parser.add_argument("--base-url", default="http://140.115.54.62:11434/v1")
    parser.add_argument("--api-key", default="ollama-key")
    parser.add_argument("--basic-auth", default=None, help="Optional HTTP Authorization value; do not commit it")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=600, help="Per-case seconds")
    parser.add_argument("--out", type=Path, default=root / "results" / "gpt-oss-120b" / "delete")
    args = parser.parse_args()

    data_dir = root / "data" / "creation_edit" / "delete"
    cases = [path for path in data_dir.glob("create-del-*") if path.is_dir()]
    cases = [path for path in sorted(cases, key=case_number) if case_number(path) >= args.start][: args.limit]
    if not cases:
        raise SystemExit("No matching delete cases found")

    args.out.mkdir(parents=True, exist_ok=True)
    summary: list[dict[str, Any]] = []
    for index, case_dir in enumerate(cases, start=1):
        case_id = case_dir.name
        print(f"[{index}/{len(cases)}] {case_id}", flush=True)
        base = read_json(case_dir / "base.json")
        instruction = (case_dir / "instruction.txt").read_text(encoding="utf-8").strip()
        envelope = {
            "command": "delete",
            "payload": {
                "workflow": base,
                "instruction": instruction,
                "model": args.model,
                "api_key": args.api_key,
                "base_url": args.base_url,
                "basic_auth": args.basic_auth,
            },
        }
        try:
            execution = run_bridge(container=args.container, envelope=envelope, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            execution = {"exit_code": None, "stdout": "", "stderr": "timeout", "bridge": None}

        bridge = execution.get("bridge")
        result = bridge.get("result") if isinstance(bridge, dict) else None
        prediction = result.get("modified_workflow") if isinstance(result, dict) else None
        # Keep an always-present prediction file so local scoring can process
        # failed resolutions too. A base copy deterministically scores as fail.
        if not isinstance(prediction, dict):
            prediction = base

        output_dir = args.out / case_id
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "pred.json").write_text(json.dumps(prediction, ensure_ascii=False, indent=2), encoding="utf-8")
        record = {
            "case_id": case_id,
            "model": args.model,
            "instruction": instruction,
            "bridge_execution": execution,
            "pipeline_ok": bool(isinstance(result, dict) and result.get("ok")),
            "pipeline_step": result.get("step") if isinstance(result, dict) else None,
            "pipeline_message": result.get("message") if isinstance(result, dict) else None,
        }
        (output_dir / "run.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        summary.append({key: record[key] for key in ("case_id", "model", "pipeline_ok", "pipeline_step", "pipeline_message")})

    (args.out / "run-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved {len(summary)} cases to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
