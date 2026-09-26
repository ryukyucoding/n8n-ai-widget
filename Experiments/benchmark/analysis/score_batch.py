#!/usr/bin/env python3
"""Aggregate score_case results under benchmark/results/."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List

BENCHMARK_ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results-dir", type=Path, default=BENCHMARK_ROOT / "results")
    ap.add_argument("--runner", choices=["local", "cloud", "any"], default="any")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    rows: List[Dict[str, Any]] = []
    for score_path in sorted(args.results_dir.rglob("score.json")):
        runner = score_path.parts[score_path.parts.index("results") + 1] if "results" in score_path.parts else "?"
        if args.runner != "any" and runner != args.runner:
            continue
        try:
            data = json.loads(score_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        case_id = score_path.parent.name
        op = score_path.parts[score_path.parts.index("results") + 2] if len(score_path.parts) > 3 else "?"
        rows.append(
            {
                "runner": runner,
                "operation": op,
                "case_id": case_id,
                "success": bool(data.get("success")),
                "primary_metric": data.get("primary_metric"),
                "insert_status": data.get("insert_status"),
                "insert_status_label": data.get("insert_status_label"),
                "error": data.get("error"),
                "metrics": data.get("metrics") or {},
                "score_path": str(score_path.relative_to(BENCHMARK_ROOT)),
            }
        )

    by_op: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_op[f"{r['runner']}:{r['operation']}"].append(r)

    summary = {"total_scored": len(rows), "groups": {}}
    for key, group in sorted(by_op.items()):
        n = len(group)
        ok = sum(1 for g in group if g["success"])
        group_summary = {
            "count": n,
            "success": ok,
            "success_rate": round(ok / n, 4) if n else 0.0,
        }
        insert_rows = [g for g in group if g.get("insert_status_label")]
        if insert_rows:
            tier_counts = Counter(g["insert_status_label"] for g in insert_rows)
            group_summary["insert_status_counts"] = dict(sorted(tier_counts.items()))
        summary["groups"][key] = group_summary

    out_path = args.out or (args.results_dir / "summary.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
