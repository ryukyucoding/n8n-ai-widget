#!/usr/bin/env python3
"""Run Insert benchmark cases through the deployed chatbot container."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def case_number(path: Path) -> int:
    try:
        return int(path.name.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return sys.maxsize


def invoke(container: str, envelope: dict[str, Any], timeout: int) -> dict[str, Any]:
    result = subprocess.run(
        ["docker", "exec", "-i", container, "python3", "/app/python/widget_agent_bridge.py"],
        input=json.dumps(envelope, ensure_ascii=False), text=True, capture_output=True,
        timeout=timeout, check=False,
    )
    raw = result.stdout.strip()
    try:
        bridge = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        bridge = None
    return {"exit_code": result.returncode, "stdout": raw, "stderr": result.stderr.strip(), "bridge": bridge}


def main() -> int:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Run Insert benchmark through n8n-chatbot container")
    parser.add_argument("--container", default="n8n-chatbot-1")
    parser.add_argument("--model", default="gpt-oss:120b")
    parser.add_argument("--base-url", default="http://140.115.54.62:11434/v1")
    parser.add_argument("--api-key", default="ollama-key")
    parser.add_argument("--basic-auth", default=None)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--out", type=Path, default=root / "results" / "gpt-oss-120b" / "insert")
    args = parser.parse_args()

    case_root = root / "data" / "creation_edit" / "insert"
    cases = [p for p in sorted(case_root.glob("create-ins-*"), key=case_number) if case_number(p) >= args.start]
    cases = cases[: args.limit]
    if not cases:
        raise SystemExit("No matching insert cases found")
    args.out.mkdir(parents=True, exist_ok=True)
    summary: list[dict[str, Any]] = []

    for number, case_dir in enumerate(cases, start=1):
        case_id = case_dir.name
        print(f"[{number}/{len(cases)}] {case_id}", flush=True)
        base = read_json(case_dir / "base.json")
        instruction = (case_dir / "instruction.txt").read_text(encoding="utf-8").strip()
        envelope = {"command": "insert", "payload": {
            "workflow": base, "instruction": instruction, "model": args.model,
            "api_key": args.api_key, "base_url": args.base_url, "basic_auth": args.basic_auth,
        }}
        try:
            execution = invoke(args.container, envelope, args.timeout)
        except subprocess.TimeoutExpired:
            execution = {"exit_code": None, "stdout": "", "stderr": "timeout", "bridge": None}
        bridge = execution.get("bridge")
        result = bridge.get("result") if isinstance(bridge, dict) else None
        prediction = result.get("modified_workflow") if isinstance(result, dict) else None
        if not isinstance(prediction, dict):
            prediction = base

        output = args.out / case_id
        output.mkdir(parents=True, exist_ok=True)
        (output / "pred.json").write_text(json.dumps(prediction, ensure_ascii=False, indent=2), encoding="utf-8")
        record = {
            "case_id": case_id, "model": args.model, "instruction": instruction,
            "bridge_execution": execution,
            "pipeline_ok": bool(isinstance(result, dict) and result.get("ok")),
            "pipeline_step": result.get("step") if isinstance(result, dict) else None,
            "pipeline_message": result.get("message") if isinstance(result, dict) else None,
        }
        (output / "run.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        summary.append({key: record[key] for key in ("case_id", "model", "pipeline_ok", "pipeline_step", "pipeline_message")})

    (args.out / "run-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved {len(summary)} cases to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
