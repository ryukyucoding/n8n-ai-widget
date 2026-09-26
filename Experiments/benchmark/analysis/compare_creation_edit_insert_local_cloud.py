#!/usr/bin/env python3
"""Compare Our AI Chatbot vs Official Bot on creation-edit insert cases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

JSONDict = Dict[str, Any]
BENCHMARK_ROOT = Path(__file__).resolve().parent.parent

INSERT_FAIL_EXPLAIN = {
    "ok_insert_task": "完全正確",
    "inserted_node_missing": "未插入目標節點",
    "insert_position_mismatch": "位置錯",
    "insert_type_mismatch": "類型錯",
    "insert_params_incomplete": "參數未覆蓋",
    "survivor_semantic_drift": "改了其他節點",
    "node_set_mismatch": "節點集合不符",
}

COMP_KEYS = [
    ("insert_position_ok", "Position OK"),
    ("insert_type_ok", "Type OK"),
    ("insert_params_cover_gold", "Params cover gold"),
    ("insert_survivors_match_oracle", "Survivors match oracle"),
    ("insert_no_extra_raw_nodes", "No extra raw nodes"),
    ("insert_success", "Insert success"),
]


def load_case(runner: str, case_id: str) -> JSONDict:
    base = BENCHMARK_ROOT / "results" / runner / "create-ins" / case_id
    score: JSONDict = {}
    if (base / "score.json").is_file():
        score = json.loads((base / "score.json").read_text(encoding="utf-8"))
    metrics = score.get("metrics") or {}
    err = metrics.get("insert_error_type")
    return {
        "runner": runner,
        "case_id": case_id,
        "has_result": bool(score),
        "success": score.get("success"),
        "error_type": err,
        "error_explain": INSERT_FAIL_EXPLAIN.get(str(err or ""), err),
        "metrics": metrics,
    }


def parse_cases(spec: str) -> List[str]:
    if ":" in spec and spec.count(",") == 0:
        start, end = spec.split(":", 1)
        prefix = start.rsplit("-", 1)[0]
        a = int(start.rsplit("-", 1)[1])
        b = int(end.rsplit("-", 1)[1])
        w = len(start.rsplit("-", 1)[1])
        return [f"{prefix}-{i:0{w}d}" for i in range(a, b + 1)]
    return [c.strip() for c in spec.split(",") if c.strip()]


def summarize(rows: List[JSONDict]) -> JSONDict:
    def stats(side: str) -> JSONDict:
        xs = [r[side] for r in rows if r[side]["has_result"]]
        n = len(xs)
        ok = sum(1 for x in xs if x.get("success") is True)
        comp: JSONDict = {}
        cov_vals: List[float] = []
        for key, _ in COMP_KEYS:
            vals = [x["metrics"].get(key) for x in xs if x["metrics"].get(key) is not None]
            comp[key] = round(sum(vals) / len(vals), 4) if vals else None
        for x in xs:
            v = x["metrics"].get("insert_param_coverage_rate")
            if v is not None:
                cov_vals.append(float(v))
        return {
            "n": n,
            "scored_success": ok,
            "success_rate": round(ok / n, 4) if n else None,
            "mean_param_coverage_rate": round(sum(cov_vals) / len(cov_vals), 4) if cov_vals else None,
            "component_means": comp,
        }

    both_ok = sum(1 for r in rows if r["local"].get("success") and r["cloud"].get("success"))
    local_only = sum(1 for r in rows if r["local"].get("success") and not r["cloud"].get("success"))
    cloud_only = sum(1 for r in rows if r["cloud"].get("success") and not r["local"].get("success"))
    both_fail = sum(
        1
        for r in rows
        if r["local"].get("has_result")
        and r["cloud"].get("has_result")
        and not r["local"].get("success")
        and not r["cloud"].get("success")
    )
    return {
        "local": stats("local"),
        "cloud": stats("cloud"),
        "agreement": {
            "both_ok": both_ok,
            "local_only_ok": local_only,
            "cloud_only_ok": cloud_only,
            "both_fail": both_fail,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="create-ins-001:create-ins-030")
    ap.add_argument(
        "--out",
        type=Path,
        default=BENCHMARK_ROOT / "results" / "creation_edit_insert_local_vs_cloud.json",
    )
    args = ap.parse_args()
    case_ids = parse_cases(args.cases)

    manifest_path = BENCHMARK_ROOT / "data" / "manifest_creation_edit.json"
    complexity: Dict[str, str] = {}
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        complexity = {c["id"]: c.get("complexity", "") for c in manifest.get("insert_cases") or []}

    rows = [
        {
            "case_id": cid,
            "complexity": complexity.get(cid, ""),
            "local": load_case("local", cid),
            "cloud": load_case("cloud", cid),
        }
        for cid in case_ids
    ]
    summary = summarize(rows)
    out = {"cases": case_ids, "summary": summary, "rows": rows}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=" * 78)
    print("Creation-edit Insert: Our AI Chatbot vs Official Bot")
    print("=" * 78)
    loc, clo = summary["local"], summary["cloud"]
    print(f"Local  — insert_success {loc['scored_success']}/{loc['n']} ({loc['success_rate']:.0%})")
    print(f"Cloud  — insert_success {clo['scored_success']}/{clo['n']} ({clo['success_rate']:.0%})")
    ag = summary["agreement"]
    print(f"Both OK: {ag['both_ok']}  Local only: {ag['local_only_ok']}  Cloud only: {ag['cloud_only_ok']}  Both fail: {ag['both_fail']}")
    print(f"\n{'Component':<28} {'Local':>8} {'Cloud':>8}")
    for key, label in COMP_KEYS:
        lm, cm = loc["component_means"].get(key), clo["component_means"].get(key)
        print(f"{label:<28} {lm:.0%} {cm:.0%}" if lm is not None else f"{label:<28} {'—':>8} {'—':>8}")
    print(f"{'Mean param coverage':<28} {loc['mean_param_coverage_rate']:.0%} {clo['mean_param_coverage_rate']:.0%}")
    print(f"\nFull JSON: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
