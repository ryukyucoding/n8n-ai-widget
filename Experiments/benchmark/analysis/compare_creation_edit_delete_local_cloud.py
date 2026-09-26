#!/usr/bin/env python3
"""Compare local widget vs Cloud AI Builder on creation-edit delete cases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

JSONDict = Dict[str, Any]
BENCHMARK_ROOT = Path(__file__).resolve().parent.parent

DELETE_FAIL_EXPLAIN = {
    "ok_delete_task": "正確刪除",
    "target_still_present": "目標仍在",
    "wrong_or_incomplete_removal": "多刪/少到",
    "survivor_semantic_drift": "改了其他節點",
    "connections_mismatch": "連線錯",
    "node_set_mismatch": "節點集合不符",
}

COMP_KEYS = [
    ("delete_targets_removed", "Target removed"),
    ("delete_only_intended_removed", "Only intended removed"),
    ("delete_survivors_match_oracle", "Survivors match"),
    ("delete_connections_match_oracle", "Connections match"),
    ("delete_no_extra_raw_nodes", "No extra raw nodes"),
    ("delete_success", "Delete success"),
]


def local_dir(case_id: str) -> Path:
    return BENCHMARK_ROOT / "results" / "local" / "delete" / case_id


def cloud_dir(case_id: str) -> Path:
    return BENCHMARK_ROOT / "results" / "cloud" / "create-del" / case_id


def load_case(runner: str, case_id: str) -> JSONDict:
    base = local_dir(case_id) if runner == "local" else cloud_dir(case_id)
    meta: JSONDict = {}
    score: JSONDict = {}
    if (base / "meta.json").is_file():
        meta = json.loads((base / "meta.json").read_text(encoding="utf-8"))
    if (base / "score.json").is_file():
        score = json.loads((base / "score.json").read_text(encoding="utf-8"))
    metrics = score.get("metrics") or {}
    err = metrics.get("delete_error_type")
    workflow_changed = meta.get("workflowChangedFromBase")
    if workflow_changed is None:
        workflow_changed = meta.get("workflowChanged")
    return {
        "runner": runner,
        "case_id": case_id,
        "has_result": bool(score),
        "success": score.get("success"),
        "error_type": err,
        "error_explain": DELETE_FAIL_EXPLAIN.get(str(err or ""), err),
        "workflow_changed": workflow_changed,
        "metrics": metrics,
        "runner_error": meta.get("error"),
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
        changed = sum(1 for x in xs if x.get("workflow_changed") is True)
        err = sum(1 for x in xs if x.get("runner_error"))
        comp: JSONDict = {}
        for key, _ in COMP_KEYS:
            vals = [x["metrics"].get(key) for x in xs if x["metrics"].get(key) is not None]
            comp[key] = round(sum(vals) / len(vals), 4) if vals else None
        return {
            "n": n,
            "scored_success": ok,
            "success_rate": round(ok / n, 4) if n else None,
            "workflow_changed": changed,
            "runner_errors": err,
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
    ap.add_argument("--cases", default="create-del-001:create-del-025")
    ap.add_argument(
        "--out",
        type=Path,
        default=BENCHMARK_ROOT / "results" / "creation_edit_delete_local_vs_cloud.json",
    )
    args = ap.parse_args()
    case_ids = parse_cases(args.cases)

    manifest_path = BENCHMARK_ROOT / "data" / "manifest_creation_edit.json"
    complexity: Dict[str, str] = {}
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        complexity = {c["id"]: c.get("complexity", "") for c in manifest.get("delete_cases") or []}

    rows: List[JSONDict] = []
    for cid in case_ids:
        rows.append(
            {
                "case_id": cid,
                "complexity": complexity.get(cid, ""),
                "local": load_case("local", cid),
                "cloud": load_case("cloud", cid),
            }
        )

    summary = summarize(rows)
    out = {"cases": case_ids, "summary": summary, "rows": rows}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=" * 78)
    print("Creation-edit Delete: Local Widget vs Cloud AI Builder")
    print("=" * 78)
    print(f"Cases: {case_ids[0]} … {case_ids[-1]} ({len(case_ids)} cases)")
    print()
    loc, clo = summary["local"], summary["cloud"]
    print(
        f"Local  — success {loc['scored_success']}/{loc['n']} "
        f"({loc['success_rate']:.0%})  changed {loc['workflow_changed']}"
    )
    print(
        f"Cloud  — success {clo['scored_success']}/{clo['n']} "
        f"({clo['success_rate']:.0%})  changed {clo['workflow_changed']}"
    )
    print()
    ag = summary["agreement"]
    print(
        f"Both OK: {ag['both_ok']}  |  Local only OK: {ag['local_only_ok']}  "
        f"|  Cloud only OK: {ag['cloud_only_ok']}  |  Both fail: {ag['both_fail']}"
    )
    print()
    print(f"{'Component':<28} {'Local':>8} {'Cloud':>8}")
    for key, label in COMP_KEYS:
        lm = loc["component_means"].get(key)
        cm = clo["component_means"].get(key)
        ls = f"{lm:.0%}" if lm is not None else "—"
        cs = f"{cm:.0%}" if cm is not None else "—"
        print(f"{label:<28} {ls:>8} {cs:>8}")
    print()
    print(f"{'Case':<16} {'Tier':<6} {'Local':<6} {'Cloud':<6}  Detail")
    print("-" * 78)
    for r in rows:
        l, c = r["local"], r["cloud"]
        lt = "OK" if l.get("success") else ("—" if not l.get("has_result") else "FAIL")
        ct = "OK" if c.get("success") else ("—" if not c.get("has_result") else "FAIL")
        ld = l.get("error_explain") or "-"
        cd = c.get("error_explain") or "-"
        mark = "  <--" if l.get("success") != c.get("success") else ""
        print(f"{r['case_id']:<16} {r['complexity']:<6} {lt:<6} {ct:<6}  L:{ld} | C:{cd}{mark}")
    print()
    print(f"Full JSON: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
