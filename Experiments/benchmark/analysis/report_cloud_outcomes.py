#!/usr/bin/env python3
"""
Human-readable cloud benchmark report.

Answers for each case:
  - Did the AI change the workflow (API-visible)?
  - If not: clarifying question / plan approval / said changed but didn't / error / unknown
  - If yes: scored correct? what went wrong? collateral damage?
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

JSONDict = Dict[str, Any]
BENCHMARK_ROOT = Path(__file__).resolve().parent.parent

DELETE_FAIL_EXPLAIN = {
    "target_still_present": "目標節點仍在（沒刪到）",
    "wrong_or_incomplete_removal": "刪了目標但多刪/少刪其他節點",
    "survivor_semantic_drift": "未刪節點的參數或語意被改動",
    "connections_mismatch": "連線與標準答案不一致",
    "node_set_mismatch": "節點名稱集合與標準答案不一致",
    "delete_partial": "部分正確但未完全符合",
    "pred_invalid": "預測 workflow 格式無效",
    "normalize_failed": "評分正規化失敗",
}

INSERT_TIER_EXPLAIN = {
    "Perfect": "節點、type、splice、參數全部正確",
    "Splice Error": "節點插入但主流程接線位置錯誤",
    "Insert Type Mismatch": "節點名稱對但 type 錯誤",
    "Ambiguous": "節點/type/splice/參數/連線/副作用等至少一項未達 Perfect（見 score.json insert_detail）",
    "Ask OK": "預期反問，AI 有適當追問",
}


def _load_json(path: Path) -> Optional[JSONDict]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _looks_like_error(text: str) -> bool:
    t = text.lower()
    return bool(
        re.search(
            r"error|failed|timeout|too long|maximum|context_overflow|invalid_request",
            t,
            re.I,
        )
    )


def classify_no_change_reason(meta: JSONDict) -> Tuple[str, str]:
    ao = meta.get("aiOutcome") or {}
    last = str(ao.get("lastAssistantText") or "")
    persisted = bool((meta.get("persist") or {}).get("persisted"))

    if ao.get("looksLikeClarification"):
        return "no_change_ask", "AI 反問/clarify，workflow 未改"
    if ao.get("looksLikePlanApproval"):
        return "no_change_plan", "AI 等待確認/plan approval，workflow 未改"
    if ao.get("looksLikeRefusal"):
        return "no_change_refusal", "AI 拒絕或表示無法執行"
    if ao.get("looksLikeWrongEdit") or (
        ao.get("aiReportedWorkflowUpdated") and not ao.get("workflowChanged")
    ):
        return "no_change_false_positive", "AI 宣稱已修改但 API 未 persist"
    if _looks_like_error(last) or meta.get("error"):
        return "no_change_error", "AI 或 runner 回報錯誤"
    if not persisted and ao.get("aiReportedWorkflowUpdated"):
        return "no_change_false_positive", "AI 宣稱已修改但 API 未 persist"
    if meta.get("error"):
        return "no_change_runner_error", f"Runner 錯誤: {meta.get('error')}"
    return "no_change_unknown", "workflow 未改，原因不明（AI 未反問也未報錯）"


def classify_delete_changed(score: JSONDict) -> Tuple[str, str]:
    m = score.get("metrics") or {}
    if score.get("success"):
        return "changed_ok", "刪除正確，無多餘改動"
    err = str(m.get("delete_error_type") or "unknown")
    detail = DELETE_FAIL_EXPLAIN.get(err, err)
    collateral = []
    if m.get("delete_only_intended_removed") == 0.0 and m.get("delete_targets_removed") == 1.0:
        collateral.append("多刪了其他節點")
    if m.get("delete_targets_removed") == 0.0:
        collateral.append("目標節點仍在")
    if m.get("delete_survivors_match_oracle") == 0.0:
        collateral.append("未刪節點被改動")
    if m.get("delete_connections_match_oracle") == 0.0:
        collateral.append("連線被改動")
    if collateral:
        detail = f"{detail}（{'；'.join(collateral)}）"
    return f"changed_fail_{err}", detail


def classify_insert_changed(score: JSONDict, meta: JSONDict) -> Tuple[str, str]:
    tier = score.get("insert_status_label") or "Ambiguous"
    if tier == "Ask OK":
        return "changed_ask_unexpected", "預期 workflow 插入但 AI 只回文字"
    explain = INSERT_TIER_EXPLAIN.get(tier, tier)
    detail = score.get("insert_detail") or {}
    if detail.get("summary_zh"):
        explain = f"{explain} — {detail['summary_zh']}"
    elif score.get("insert_ambiguity_label"):
        explain = f"{explain}（{score['insert_ambiguity_label']}）"
    if score.get("success") and tier == "Perfect":
        return "changed_ok_perfect", explain
    slug = tier.lower().replace(" ", "_")
    return f"changed_{slug}", explain


def classify_case(case_dir: Path, operation: str) -> JSONDict:
    meta = _load_json(case_dir / "meta.json") or {}
    score = _load_json(case_dir / "score.json") or {}
    ao = meta.get("aiOutcome") or {}
    changed = bool(ao.get("workflowChanged"))
    persisted = bool((meta.get("persist") or {}).get("persisted"))

    row: JSONDict = {
        "case_id": case_dir.name,
        "operation": operation,
        "ai_changed_workflow": changed,
        "api_persisted": persisted,
        "scored_success": bool(score.get("success")),
        "last_ai_snippet": str(ao.get("lastAssistantText") or "")[:300],
    }

    if meta.get("error") and not score:
        code, explain = "runner_error", str(meta.get("error"))
    elif not changed:
        code, explain = classify_no_change_reason(meta)
    elif operation == "delete":
        code, explain = classify_delete_changed(score)
    elif operation == "insert" or operation.startswith("insert"):
        code, explain = classify_insert_changed(score, meta)
    else:
        m = score.get("metrics") or {}
        if score.get("success"):
            code, explain = "changed_ok", "修改正確"
        else:
            code, explain = (
                f"changed_fail_{m.get('modify_error_type', 'unknown')}",
                str(m.get("modify_error_type") or "修改不符合 gold"),
            )

    row["outcome_code"] = code
    row["outcome_explain_zh"] = explain
    if score.get("insert_status_label"):
        row["insert_tier"] = score["insert_status_label"]
    if score.get("insert_ambiguity_label"):
        row["insert_ambiguity_label"] = score["insert_ambiguity_label"]
    if score.get("insert_detail", {}).get("summary_zh"):
        row["insert_detail_summary"] = score["insert_detail"]["summary_zh"]
    if score.get("metrics", {}).get("delete_error_type"):
        row["delete_error_type"] = score["metrics"]["delete_error_type"]
    return row


def aggregate(rows: List[JSONDict]) -> JSONDict:
    by_op: Dict[str, List[JSONDict]] = defaultdict(list)
    for r in rows:
        op = r["operation"]
        if op.startswith("insert"):
            op = "insert"
        by_op[op].append(r)

    summary: JSONDict = {"total": len(rows), "operations": {}}
    for op, group in sorted(by_op.items()):
        n = len(group)
        changed = sum(1 for g in group if g["ai_changed_workflow"])
        not_changed = n - changed
        scored_ok = sum(1 for g in group if g["scored_success"])
        outcome_counts = Counter(g["outcome_code"] for g in group)

        op_summary: JSONDict = {
            "count": n,
            "ai_changed_workflow": changed,
            "ai_no_change": not_changed,
            "scored_success": scored_ok,
            "scored_success_rate": round(scored_ok / n, 4) if n else 0.0,
            "outcome_counts": dict(sorted(outcome_counts.items())),
        }

        if op == "insert":
            tier = Counter(g.get("insert_tier") for g in group if g.get("insert_tier"))
            op_summary["insert_tier_counts"] = dict(sorted(tier.items()))

        # Roll up no-change reasons
        no_change = [g for g in group if not g["ai_changed_workflow"]]
        if no_change:
            nc = Counter(g["outcome_code"] for g in no_change)
            op_summary["no_change_breakdown"] = {
                k: {"count": v, "explain": next(
                    (g["outcome_explain_zh"] for g in no_change if g["outcome_code"] == k), k
                )}
                for k, v in sorted(nc.items())
            }

        changed_rows = [g for g in group if g["ai_changed_workflow"]]
        if changed_rows:
            cc = Counter(g["outcome_code"] for g in changed_rows)
            op_summary["changed_breakdown"] = {
                k: {"count": v, "explain": next(
                    (g["outcome_explain_zh"] for g in changed_rows if g["outcome_code"] == k), k
                )}
                for k, v in sorted(cc.items())
            }

        summary["operations"][op] = op_summary

    return summary


def print_human_report(summary: JSONDict, rows: List[JSONDict]) -> None:
    print("=" * 60)
    print("Cloud Benchmark 結果解讀")
    print("=" * 60)
    print(f"共 {summary['total']} 個 case\n")

    for op, s in summary.get("operations", {}).items():
        print(f"## {op.upper()} ({s['count']} cases)")
        print(f"  AI 有改 workflow (API): {s['ai_changed_workflow']}")
        print(f"  AI 沒改 workflow:       {s['ai_no_change']}")
        print(f"  評分 success:           {s['scored_success']} ({s['scored_success_rate']*100:.1f}%)")

        if s.get("no_change_breakdown"):
            print("\n  【沒改】原因分布:")
            for code, info in s["no_change_breakdown"].items():
                print(f"    - {info['count']}× {info['explain']}")

        if s.get("changed_breakdown"):
            print("\n  【有改】結果分布:")
            for code, info in s["changed_breakdown"].items():
                print(f"    - {info['count']}× {info['explain']}")

        if op == "insert" and s.get("insert_tier_counts"):
            print("\n  【Insert 四階】:")
            for tier, cnt in s["insert_tier_counts"].items():
                exp = INSERT_TIER_EXPLAIN.get(tier, tier)
                print(f"    - {tier}: {cnt} ({exp})")
        print()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--results-dir",
        type=Path,
        default=BENCHMARK_ROOT / "results" / "cloud",
    )
    ap.add_argument("--operation", choices=["delete", "insert", "all"], default="all")
    ap.add_argument("--out-json", type=Path, default=None)
    ap.add_argument("--out-csv", type=Path, default=None)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    rows: List[JSONDict] = []
    root = args.results_dir
    if not root.is_dir():
        print(f"No results dir: {root}")
        return 1

    for op_dir in sorted(root.iterdir()):
        if not op_dir.is_dir():
            continue
        op_name = op_dir.name
        if args.operation == "delete" and op_name != "delete":
            continue
        if args.operation == "insert" and not op_name.startswith("insert"):
            continue
        for case_dir in sorted(op_dir.iterdir()):
            if not case_dir.is_dir():
                continue
            if not (case_dir / "meta.json").exists():
                continue
            rows.append(classify_case(case_dir, op_name))

    summary = aggregate(rows)
    summary["cases"] = rows

    out_json = args.out_json or (root / "outcome_report.json")
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.out_csv:
        import csv

        fields = [
            "case_id", "operation", "ai_changed_workflow", "api_persisted",
            "scored_success", "outcome_code", "outcome_explain_zh",
            "insert_tier", "delete_error_type", "last_ai_snippet",
        ]
        with args.out_csv.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow(r)

    if not args.quiet:
        print_human_report(summary, rows)
        print(f"Full report: {out_json}")
        if args.out_csv:
            print(f"CSV: {args.out_csv}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
