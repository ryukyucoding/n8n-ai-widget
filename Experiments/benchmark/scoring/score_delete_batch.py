#!/usr/bin/env python3
"""Score batch output produced by ../run_delete_container.py."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

BENCHMARK_ROOT = Path(__file__).resolve().parent.parent
if str(BENCHMARK_ROOT) not in sys.path:
    sys.path.insert(0, str(BENCHMARK_ROOT))

from scoring.score_edit import score_case  # noqa: E402


def load(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Score a batch of Delete predictions")
    parser.add_argument("--pred-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    data_dir = BENCHMARK_ROOT / "data" / "creation_edit" / "delete"
    rows: list[dict[str, Any]] = []
    for prediction in sorted(args.pred_dir.glob("create-del-*/pred.json")):
        case_id = prediction.parent.name
        base_path = data_dir / case_id / "base.json"
        gold_path = data_dir / case_id / "gold.json"
        if not base_path.exists() or not gold_path.exists():
            continue
        result = score_case(operation="delete", base=load(base_path), gold=load(gold_path), pred=load(prediction))
        run_path = prediction.parent / "run.json"
        run = load(run_path) if run_path.exists() else {}
        rows.append({
            "case_id": case_id,
            "delete_success": int(bool(result.get("success"))),
            "pipeline_ok": int(bool(run.get("pipeline_ok"))),
            "pipeline_step": run.get("pipeline_step") or "",
            "pipeline_message": run.get("pipeline_message") or "",
            "score": result,
        })

    summary = {
        "total": len(rows),
        "delete_success": sum(row["delete_success"] for row in rows),
        "pipeline_ok": sum(row["pipeline_ok"] for row in rows),
        "rows": rows,
    }
    summary["delete_success_rate"] = round(summary["delete_success"] / len(rows), 4) if rows else 0.0
    output = args.out or args.pred_dir / "score-summary.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    csv_path = output.with_suffix(".csv")
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["case_id", "delete_success", "pipeline_ok", "pipeline_step", "pipeline_message"])
        writer.writeheader()
        writer.writerows([{key: row[key] for key in writer.fieldnames} for row in rows])
    print(json.dumps({key: summary[key] for key in ("total", "delete_success", "delete_success_rate", "pipeline_ok")}, ensure_ascii=False, indent=2))
    print(f"Details: {output}\nTable: {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
