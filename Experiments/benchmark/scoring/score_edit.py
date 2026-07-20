"""Score delete / insert / modify predictions against gold."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Optional

from scoring import setup_path

setup_path()

from evaluation.comparison.workflow_normalizer import WorkflowNormalizer
from evaluation.evaluators.delete_task_evaluator import evaluate_delete_task
from evaluation.evaluators.modify_task_evaluator import (
    _connections_key,
    _nodes_by_name_from_raw,
    _semantic_key,
)
from evaluation.evaluators.modify_task_evaluator import evaluate_modify_task
from insert.evaluate_insert import (
    evaluate_insert,
    main_neighbor_signature,
    normalize_for_params_cover,
    pred_parameters_cover_gold,
    workflow_node_by_name,
)

JSONDict = Dict[str, Any]

INSERT_STATUS_LABELS = {
    "perfect": "Perfect",
    "splice_error": "Splice Error",
    "insert_type_mismatch": "Insert Type Mismatch",
    "ambiguous": "Ambiguous",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _workflow_node_names(wf: JSONDict) -> list[str]:
    return [str(n["name"]) for n in wf.get("nodes") or [] if isinstance(n, dict) and n.get("name")]


def _count_gold_param_paths(gold: Any, pred: Any, path: str = "") -> tuple[int, int, list[str]]:
    g = normalize_for_params_cover(gold)
    p = normalize_for_params_cover(pred)

    if g is None or g == {} or g == []:
        return 0, 0, []

    if g == p:
        return 1, 1, []

    if isinstance(g, dict):
        if not isinstance(p, dict):
            leaf = path or "(root)"
            return 1, 0, [leaf]
        total = covered = 0
        missing: list[str] = []
        for key, gv in g.items():
            sub_path = f"{path}.{key}" if path else str(key)
            gkn = normalize_for_params_cover(gv)
            if gkn is None or gkn == {} or gkn == []:
                continue
            if key not in p:
                total += 1
                missing.append(sub_path)
                continue
            st, sc, sm = _count_gold_param_paths(gv, p[key], sub_path)
            total += st
            covered += sc
            missing.extend(sm)
        return total, covered, missing

    if isinstance(g, list):
        if not isinstance(p, list) or len(p) < len(g):
            leaf = path or "(root)"
            return max(1, len(g)), 0, [leaf]
        total = covered = 0
        missing: list[str] = []
        for i, gv in enumerate(g):
            st, sc, sm = _count_gold_param_paths(gv, p[i], f"{path}[{i}]")
            total += st
            covered += sc
            missing.extend(sm)
        return total, covered, missing

    leaf = path or "(root)"
    ok = pred_parameters_cover_gold(gold, pred)
    return 1, (1 if ok else 0), ([] if ok else [leaf])


def evaluate_insert_task(
    *,
    normalizer: WorkflowNormalizer,
    template_wf: JSONDict,
    oracle_wf: JSONDict,
    pred_wf: JSONDict,
    inserted_node_name: str,
) -> JSONDict:
    inserted = str(inserted_node_name or "").strip()
    base: JSONDict = {
        "insert_target_node_name": inserted,
        "insert_position_ok": 0.0,
        "insert_type_ok": 0.0,
        "insert_params_cover_gold": 0.0,
        "insert_param_coverage_rate": 0.0,
        "insert_survivors_match_oracle": 0.0,
        "insert_no_extra_raw_nodes": 0.0,
        "insert_success": 0.0,
        "insert_error_type": "pred_invalid",
    }

    if not pred_wf or not isinstance(pred_wf, dict):
        return base
    if "nodes" not in pred_wf or "connections" not in pred_wf:
        base["insert_error_type"] = "pred_invalid"
        return base

    t_raw = set(_workflow_node_names(template_wf))
    o_raw = set(_workflow_node_names(oracle_wf))
    p_raw = set(_workflow_node_names(pred_wf))

    try:
        bo, _ = _nodes_by_name_from_raw(normalizer, oracle_wf)
        bp, _ = _nodes_by_name_from_raw(normalizer, pred_wf)
    except Exception:
        base["insert_error_type"] = "normalize_failed"
        return base

    in_pred = inserted in p_raw
    on = workflow_node_by_name(oracle_wf, inserted) if inserted else None
    pn = workflow_node_by_name(pred_wf, inserted) if in_pred else None

    position_ok = False
    if in_pred and inserted:
        position_ok = main_neighbor_signature(oracle_wf, inserted) == main_neighbor_signature(pred_wf, inserted)

    type_ok = False
    if in_pred and isinstance(on, dict) and isinstance(pn, dict):
        type_ok = on.get("type") == pn.get("type")

    params_cover = False
    coverage_rate = 1.0
    if in_pred and isinstance(on, dict) and isinstance(pn, dict):
        gp = on.get("parameters")
        pp = pn.get("parameters")
        if isinstance(gp, dict):
            total, covered, _ = _count_gold_param_paths(gp, pp if isinstance(pp, dict) else {})
            coverage_rate = (covered / total) if total else 1.0
            params_cover = pred_parameters_cover_gold(gp, pp) if isinstance(pp, dict) else False
        else:
            params_cover = True

    survivors_match = True
    for name in sorted(t_raw):
        if name not in bo:
            continue
        if name not in bp:
            survivors_match = False
            break
        if _semantic_key(bo[name]) != _semantic_key(bp[name]):
            survivors_match = False
            break

    node_set_ok = p_raw == o_raw

    base["insert_position_ok"] = 1.0 if position_ok else 0.0
    base["insert_type_ok"] = 1.0 if type_ok else 0.0
    base["insert_params_cover_gold"] = 1.0 if params_cover else 0.0
    base["insert_param_coverage_rate"] = round(float(coverage_rate), 4)
    base["insert_survivors_match_oracle"] = 1.0 if survivors_match else 0.0
    base["insert_no_extra_raw_nodes"] = 1.0 if node_set_ok else 0.0

    parts = [position_ok, type_ok, params_cover, survivors_match, node_set_ok]
    all_ok = all(parts)
    base["insert_success"] = 1.0 if all_ok else 0.0

    if not in_pred:
        err = "inserted_node_missing"
    elif not position_ok:
        err = "insert_position_mismatch"
    elif not type_ok:
        err = "insert_type_mismatch"
    elif not params_cover:
        err = "insert_params_incomplete"
    elif not survivors_match:
        err = "survivor_semantic_drift"
    elif not node_set_ok:
        err = "node_set_mismatch"
    elif all_ok:
        err = "ok_insert_task"
    else:
        err = "insert_partial"

    base["insert_error_type"] = err
    return base


def build_insert_detail(
    *,
    base: JSONDict,
    gold: JSONDict,
    pred: JSONDict,
    clue: JSONDict,
    metrics: JSONDict,
    normalizer: WorkflowNormalizer,
) -> JSONDict:
    inserted = str(clue.get("inserted_node_name") or "")
    pred_names = set(_workflow_node_names(pred))
    base_names = set(_workflow_node_names(base))

    on = workflow_node_by_name(gold, inserted) if inserted else None
    pn = workflow_node_by_name(pred, inserted) if inserted in pred_names else None

    gold_type = on.get("type") if isinstance(on, dict) else None
    pred_type = pn.get("type") if isinstance(pn, dict) else None

    gold_neighbors = main_neighbor_signature(gold, inserted) if inserted else ((), ())
    pred_neighbors = main_neighbor_signature(pred, inserted) if inserted in pred_names else ((), ())

    params_detail: JSONDict = {
        "gold_params_subset_ok": metrics.get("gold_params_subset_ok"),
        "total_paths": 0,
        "covered_paths": 0,
        "coverage_rate": None,
        "missing_paths": [],
    }
    if isinstance(on, dict) and isinstance(pn, dict):
        gp = on.get("parameters")
        pp = pn.get("parameters")
        if isinstance(gp, dict):
            total, covered, missing = _count_gold_param_paths(gp, pp if isinstance(pp, dict) else {})
            params_detail.update(
                {
                    "total_paths": total,
                    "covered_paths": covered,
                    "coverage_rate": round(covered / total, 4) if total else 1.0,
                    "missing_paths": missing[:30],
                }
            )

    bt, _ = _nodes_by_name_from_raw(normalizer, base)
    bp, pc = _nodes_by_name_from_raw(normalizer, pred)
    changed_survivors: list[str] = []
    for name, tnode in bt.items():
        if name == inserted:
            continue
        if name not in bp:
            changed_survivors.append(f"{name} (removed)")
            continue
        if _semantic_key(tnode) != _semantic_key(bp[name]):
            changed_survivors.append(name)

    extra_nodes = sorted(set(pred_names) - set(base_names) - {inserted})
    missing_from_pred = sorted(base_names - pred_names - {inserted})

    _, gc = _nodes_by_name_from_raw(normalizer, gold)
    connections_changed = _connections_key(gc) != _connections_key(pc)

    ambiguity_reasons: list[str] = []
    if not metrics.get("inserted_node_name_ok"):
        ambiguity_reasons.append("inserted_node_missing")
    elif not metrics.get("inserted_node_type_ok"):
        ambiguity_reasons.append("inserted_type_mismatch")
    elif not metrics.get("insert_main_neighbors_ok"):
        ambiguity_reasons.append("splice_position_mismatch")
    if metrics.get("gold_params_subset_ok") is False:
        ambiguity_reasons.append("parameters_incomplete")
    if not metrics.get("ok_no_dangling"):
        ambiguity_reasons.append("dangling_connections")
    if changed_survivors:
        ambiguity_reasons.append("other_nodes_modified")
    if extra_nodes:
        ambiguity_reasons.append("extra_nodes_added")
    if missing_from_pred:
        ambiguity_reasons.append("unexpected_node_removals")

    return {
        "inserted_node_name": inserted,
        "checks": {
            "node_name_present": {
                "ok": bool(metrics.get("inserted_node_name_ok")),
                "expected_name": inserted,
                "in_pred": inserted in pred_names,
            },
            "node_type_match": {
                "ok": bool(metrics.get("inserted_node_type_ok")),
                "gold_type": gold_type,
                "pred_type": pred_type,
            },
            "splice_position": {
                "ok": bool(metrics.get("insert_main_neighbors_ok")),
                "gold_incoming": list(gold_neighbors[0]),
                "gold_outgoing": list(gold_neighbors[1]),
                "pred_incoming": list(pred_neighbors[0]),
                "pred_outgoing": list(pred_neighbors[1]),
            },
            "parameters": params_detail,
            "graph_integrity": {
                "ok_no_dangling": metrics.get("ok_no_dangling"),
                "connections_differ_from_gold": connections_changed,
            },
            "collateral": {
                "other_nodes_semantically_changed": changed_survivors,
                "extra_nodes_beyond_insert": extra_nodes,
                "base_nodes_missing_from_pred": missing_from_pred,
            },
        },
        "ambiguity_reasons": ambiguity_reasons,
    }


def classify_insert_status(
    metrics: JSONDict,
    *,
    gold_kind: str = "workflow",
    insert_detail: Optional[JSONDict] = None,
) -> JSONDict:
    if gold_kind == "ask":
        err = str(metrics.get("error_type") or "")
        ok = err == "ok_ask"
        return {
            "insert_status": "ask_ok" if ok else "ask_fail",
            "insert_status_label": "Ask OK" if ok else "Ambiguous",
            "insert_tier": "ask",
        }

    error_type = str(metrics.get("error_type") or "")

    if error_type in ("ok_strict", "ok_relaxed", "ok_insert_params_cover_gold"):
        status = "perfect"
    elif metrics.get("gold_params_subset_ok") is True:
        status = "perfect"
    elif metrics.get("inserted_node_name_ok") is True and metrics.get("inserted_node_type_ok") is False:
        status = "insert_type_mismatch"
    elif error_type == "inserted_type_mismatch":
        status = "insert_type_mismatch"
    elif metrics.get("inserted_node_ok") is True and metrics.get("insert_main_neighbors_ok") is False:
        status = "splice_error"
    elif error_type == "insert_splice_mismatch":
        status = "splice_error"
    else:
        status = "ambiguous"

    out: JSONDict = {
        "insert_status": status,
        "insert_status_label": INSERT_STATUS_LABELS[status],
        "insert_tier": status,
    }
    if status == "ambiguous" and insert_detail:
        reasons = insert_detail.get("ambiguity_reasons") or []
        if reasons:
            out["insert_ambiguity_reasons"] = reasons
            out["insert_ambiguity_label"] = ", ".join(reasons)
    return out


def build_insert_clue(case: JSONDict) -> JSONDict:
    embedded = case.get("oracle_clue")
    if isinstance(embedded, dict) and str(embedded.get("task") or "").startswith("insert"):
        clue = dict(embedded)
        clue.setdefault("output_kind", "ask" if case.get("gold_kind") == "ask" else "workflow")
        deleted = clue.get("deleted_node") or {}
        if not clue.get("inserted_node_name") and isinstance(deleted.get("name"), str):
            clue["inserted_node_name"] = deleted["name"]
        return clue

    return {
        "task": "insert_full",
        "inserted_node_name": case.get("inserted_node_name") or "",
        "output_kind": "workflow",
    }


def score_case(
    *,
    operation: str,
    base: JSONDict,
    gold: Any,
    pred: JSONDict,
    case: Optional[JSONDict] = None,
) -> JSONDict:
    normalizer = WorkflowNormalizer()
    case = case or {}

    if operation == "delete":
        if not isinstance(gold, dict):
            return {"success": False, "error": "gold_not_workflow", "metrics": {}}
        metrics = evaluate_delete_task(
            normalizer=normalizer,
            template_wf=base,
            oracle_wf=gold,
            pred_wf=pred,
        )
        return {
            "success": metrics.get("delete_success") == 1.0,
            "primary_metric": "delete_success",
            "metrics": metrics,
        }

    if operation == "modify":
        if not isinstance(gold, dict):
            return {"success": False, "error": "gold_not_workflow", "metrics": {}}
        metrics = evaluate_modify_task(
            normalizer=normalizer,
            template_wf=base,
            oracle_wf=gold,
            pred_wf=pred,
        )
        return {
            "success": metrics.get("modify_success") == 1.0,
            "primary_metric": "modify_success",
            "metrics": metrics,
        }

    if operation == "insert":
        clue = build_insert_clue(case)
        if isinstance(gold, dict) and "_ask_text" in gold:
            gold_out = gold["_ask_text"]
        else:
            gold_out = gold
        ev = evaluate_insert(oracle_out=gold_out, clue=clue, pred_raw=json.dumps(pred, ensure_ascii=False))
        ev_dict = ev.to_json() if hasattr(ev, "to_json") else dict(ev)
        insert_detail: Optional[JSONDict] = None
        task_metrics: JSONDict = {}
        if isinstance(gold, dict) and "_ask_text" not in gold:
            inserted_name = str(clue.get("inserted_node_name") or "")
            task_metrics = evaluate_insert_task(
                normalizer=normalizer,
                template_wf=base,
                oracle_wf=gold,
                pred_wf=pred,
                inserted_node_name=inserted_name,
            )
            insert_detail = build_insert_detail(
                base=base,
                gold=gold,
                pred=pred,
                clue=clue,
                metrics=ev_dict,
                normalizer=normalizer,
            )
        success = task_metrics.get("insert_success") == 1.0 if task_metrics else False
        result: JSONDict = {
            "success": bool(success),
            "primary_metric": "insert_success",
            "metrics": {**ev_dict, **task_metrics},
        }
        if insert_detail:
            result["insert_detail"] = insert_detail
            result.update(classify_insert_status(ev_dict, gold_kind=case.get("gold_kind", "workflow"), insert_detail=insert_detail))
        return result

    return {"success": False, "error": f"unknown operation: {operation}", "metrics": {}}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Score delete / insert / modify prediction vs gold")
    ap.add_argument("--operation", required=True, choices=["delete", "insert", "modify"])
    ap.add_argument("--base", type=Path, required=True)
    ap.add_argument("--gold", type=Path, required=True)
    ap.add_argument("--pred", type=Path, required=True)
    ap.add_argument("--case-json", type=Path, default=None, help="manifest case entry JSON (insert needs oracle_clue)")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)

    base = load_json(args.base)
    gold = load_json(args.gold)
    pred = load_json(args.pred)
    case = load_json(args.case_json) if args.case_json else {}

    try:
        result = score_case(
            operation=args.operation,
            base=base,
            gold=gold,
            pred=pred,
            case=case if isinstance(case, dict) else {},
        )
    except Exception as exc:
        result = {"success": False, "error": str(exc), "metrics": {}}

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
