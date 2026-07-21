#!/usr/bin/env python3
"""Score batch Insert output produced by ../run_insert_container.py."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scoring.score_edit import score_case  # noqa: E402


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Score a batch of Insert predictions")
    parser.add_argument("--pred-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    manifest = load(ROOT / "data" / "manifest_creation_edit.json")
    cases = {case["id"]: case for case in manifest.get("insert_cases", []) if isinstance(case, dict) and case.get("id")}
    data_dir = ROOT / "data" / "creation_edit" / "insert"
    rows: list[dict[str, Any]] = []
    for pred_path in sorted(args.pred_dir.glob("create-ins-*/pred.json")):
        case_id = pred_path.parent.name
        case = cases.get(case_id)
        if not case:
            continue
        base = load(data_dir / case_id / "base.json")
        gold = load(data_dir / case_id / "gold.json")
        pred = load(pred_path)
        score = score_case(operation="insert", base=base, gold=gold, pred=pred, case=case)
        run_path = pred_path.parent / "run.json"
        run = load(run_path) if run_path.exists() else {}
        metrics = score.get("metrics") or {}
        rows.append({
            "case_id": case_id,
            "insert_success": int(bool(score.get("success"))),
            "pipeline_ok": int(bool(run.get("pipeline_ok"))),
            "pipeline_step": run.get("pipeline_step") or "",
            "insert_status": score.get("insert_status_label") or "",
            "position_ok": metrics.get("insert_position_ok", metrics.get("insert_main_neighbors_ok")),
            "type_ok": metrics.get("insert_type_ok", metrics.get("inserted_node_type_ok")),
            "parameter_coverage": metrics.get("insert_param_coverage_rate"),
            "score": score,
        })

    total = len(rows)
    mean = lambda key: round(sum(float(row[key]) for row in rows if isinstance(row.get(key), (int, float))) / sum(isinstance(row.get(key), (int, float)) for row in rows), 4) if any(isinstance(row.get(key), (int, float)) for row in rows) else None
    summary = {
        "total": total,
        "insert_success": sum(row["insert_success"] for row in rows),
        "insert_success_rate": round(sum(row["insert_success"] for row in rows) / total, 4) if total else 0.0,
        "pipeline_ok": sum(row["pipeline_ok"] for row in rows),
        "mean_position_ok": mean("position_ok"),
        "mean_type_ok": mean("type_ok"),
        "mean_parameter_coverage": mean("parameter_coverage"),
        "rows": rows,
    }
    output = args.out or args.pred_dir / "score-summary.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    csv_path = output.with_suffix(".csv")
    fields = ["case_id", "insert_success", "pipeline_ok", "pipeline_step", "insert_status", "position_ok", "type_ok", "parameter_coverage"]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows([{key: row[key] for key in fields} for row in rows])
    print(json.dumps({key: summary[key] for key in summary if key != "rows"}, ensure_ascii=False, indent=2))
    print(f"Details: {output}\nTable: {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
