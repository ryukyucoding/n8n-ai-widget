#!/usr/bin/env python3
"""Compare local widget vs Cloud AI Builder on the same delete cases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

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


def load_case(runner: str, case_id: str) -> JSONDict:
    base = BENCHMARK_ROOT / "results" / runner / "delete" / case_id
    meta = {}
    score = {}
    if (base / "meta.json").is_file():
        meta = json.loads((base / "meta.json").read_text(encoding="utf-8"))
    if (base / "score.json").is_file():
        score = json.loads((base / "score.json").read_text(encoding="utf-8"))
    ao = meta.get("aiOutcome") or {}
    metrics = score.get("metrics") or {}
    steps = [s.get("step") for s in meta.get("steps") or []]
    persisted = (meta.get("persist") or {}).get("persisted")
    workflow_changed = ao.get("workflowChanged")
    if workflow_changed is None:
        workflow_changed = persisted
    return {
        "runner": runner,
        "case_id": case_id,
        "has_result": bool(score) or bool(meta.get("error")),
        "success": score.get("success"),
        "error_type": metrics.get("delete_error_type"),
        "error_explain": DELETE_FAIL_EXPLAIN.get(
            str(metrics.get("delete_error_type") or ""), metrics.get("delete_error_type")
        ),
        "workflow_changed": workflow_changed,
        "persisted": persisted,
        "prompt_sent": "prompt_sent" in steps or bool(meta.get("agentAction")),
        "runner_error": meta.get("error"),
        "agent_action": meta.get("agentAction"),
        "agent_message": (meta.get("agentMessage") or "")[:200],
        "last_ai": (ao.get("lastAssistantText") or meta.get("agentMessage") or "")[:200],
    }


def summarize(rows: List[JSONDict]) -> JSONDict:
    def stats(side: str) -> JSONDict:
        xs = [r[side] for r in rows if r[side]["has_result"]]
        n = len(xs)
        ok = sum(1 for x in xs if x.get("success") is True)
        changed = sum(1 for x in xs if x.get("workflow_changed") is True)
        sent = sum(1 for x in xs if x.get("prompt_sent"))
        err = sum(1 for x in xs if x.get("runner_error"))
        return {
            "n": n,
            "prompt_sent_or_agent": sent,
            "workflow_changed": changed,
            "scored_success": ok,
            "success_rate": round(ok / n, 4) if n else None,
            "runner_errors": err,
        }

    both_ok = sum(
        1
        for r in rows
        if r["local"].get("success") and r["cloud"].get("success")
    )
    local_only = sum(
        1
        for r in rows
        if r["local"].get("success") and not r["cloud"].get("success")
    )
    cloud_only = sum(
        1
        for r in rows
        if r["cloud"].get("success") and not r["local"].get("success")
    )
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
    ap.add_argument(
        "--cases",
        default="delete-001:delete-019",
        help="Range like delete-001:delete-019 or comma list",
    )
    ap.add_argument("--out", type=Path, default=BENCHMARK_ROOT / "results" / "delete_local_vs_cloud.json")
    args = ap.parse_args()

    case_ids: List[str] = []
    if ":" in args.cases and args.cases.count(",") == 0:
        start, end = args.cases.split(":", 1)
        prefix = start.rsplit("-", 1)[0]
        a = int(start.rsplit("-", 1)[1])
        b = int(end.rsplit("-", 1)[1])
        w = len(start.rsplit("-", 1)[1])
        case_ids = [f"{prefix}-{i:0{w}d}" for i in range(a, b + 1)]
    else:
        case_ids = [c.strip() for c in args.cases.split(",") if c.strip()]

    rows: List[JSONDict] = []
    for cid in case_ids:
        rows.append(
            {
                "case_id": cid,
                "local": load_case("local", cid),
                "cloud": load_case("cloud", cid),
            }
        )

    summary = summarize(rows)
    out = {"cases": case_ids, "summary": summary, "rows": rows}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=" * 72)
    print("Delete: Local Widget vs Cloud AI Builder")
    print("=" * 72)
    print(f"Cases: {', '.join(case_ids)}")
    print()
    loc, clo = summary["local"], summary["cloud"]
    print(f"Local  — success {loc['scored_success']}/{loc['n']}  changed {loc['workflow_changed']}  errors {loc['runner_errors']}")
    print(f"Cloud  — success {clo['scored_success']}/{clo['n']}  changed {clo['workflow_changed']}  errors {clo['runner_errors']}")
    print()
    ag = summary["agreement"]
    print(f"Both OK: {ag['both_ok']}  |  Local only OK: {ag['local_only_ok']}  |  Cloud only OK: {ag['cloud_only_ok']}  |  Both fail: {ag['both_fail']}")
    print()
    print(f"{'Case':<12} {'Local':<8} {'Cloud':<8}  Local detail / Cloud detail")
    print("-" * 72)
    for r in rows:
        lid, cid = r["case_id"], r["case_id"]
        l = r["local"]
        c = r["cloud"]
        lt = "OK" if l.get("success") else ("ERR" if l.get("runner_error") else "FAIL")
        ct = "OK" if c.get("success") else ("ERR" if c.get("runner_error") else "FAIL")
        ld = l.get("error_explain") or l.get("runner_error") or "-"
        cd = c.get("error_explain") or c.get("runner_error") or "-"
        if isinstance(ld, str):
            ld = ld.split("\n")[0][:40]
        if isinstance(cd, str):
            cd = cd.split("\n")[0][:40]
        print(f"{lid:<12} {lt:<8} {ct:<8}  L:{ld} | C:{cd}")
    print()
    print(f"Full JSON: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
