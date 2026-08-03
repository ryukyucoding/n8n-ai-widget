#!/usr/bin/env python3
"""
Modify-task evaluation (aligned with insert pipeline grading style).

Compares template (pre-edit) vs oracle (post-edit) to find nodes that should change,
then scores predictions on:
  - target node(s): type matches oracle; parameters cover oracle gold (same contract as insert)
  - non-target nodes: semantic slice (type + parameters) unchanged vs template
  - connections: normalized graph matches oracle
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Set, Tuple

from evaluation.comparison.workflow_normalizer import WorkflowNormalizer

JSONDict = Dict[str, Any]


def _json_dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _is_vacuous_cover_value(v: Any) -> bool:
    return v is None or v == {} or v == []


def _normalize_for_params_cover(v: Any) -> Any:
    if isinstance(v, bool):
        return v
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        low = s.lower()
        if low == "true":
            return True
        if low == "false":
            return False
        if (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]")):
            try:
                return _normalize_for_params_cover(json.loads(s))
            except (json.JSONDecodeError, TypeError, ValueError):
                return v
        return v
    if isinstance(v, list):
        return [_normalize_for_params_cover(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _normalize_for_params_cover(val) for k, val in v.items()}
    return v


def pred_parameters_cover_gold(gold: Any, pred: Any) -> bool:
    """
    True if pred matches gold at every path in gold after normalization (insert eval contract).
    """
    g = _normalize_for_params_cover(gold)
    p = _normalize_for_params_cover(pred)
    if g == p:
        return True
    if g is None:
        return True
    if isinstance(g, dict) and isinstance(p, dict):
        for k, gv in g.items():
            gkn = _normalize_for_params_cover(gv)
            if k not in p:
                if _is_vacuous_cover_value(gkn):
                    continue
                return False
            if not pred_parameters_cover_gold(gv, p[k]):
                return False
        return True
    if isinstance(g, list) and isinstance(p, list):
        if len(p) < len(g):
            return False
        for i in range(len(g)):
            if not pred_parameters_cover_gold(g[i], p[i]):
                return False
        return True
    return False


def _nodes_by_name_from_raw(
    normalizer: WorkflowNormalizer, wf: JSONDict
) -> Tuple[Dict[str, JSONDict], List[JSONDict]]:
    n = normalizer._normalize_from_n8n_workflow(wf)
    nodes = n.get("nodes") or []
    by_name = {str(x["name"]): x for x in nodes if isinstance(x, dict) and x.get("name")}
    return by_name, n.get("connections") or []


def _semantic_key(node: JSONDict) -> str:
    return _json_dump(
        {"type": node.get("type"), "parameters": node.get("parameters") if isinstance(node.get("parameters"), dict) else {}}
    )


def find_modified_node_names(
    template_wf: JSONDict, oracle_wf: JSONDict, normalizer: WorkflowNormalizer
) -> List[str]:
    bt, _ = _nodes_by_name_from_raw(normalizer, template_wf)
    bo, _ = _nodes_by_name_from_raw(normalizer, oracle_wf)
    names: Set[str] = set(bt) | set(bo)
    out: List[str] = []
    for name in sorted(names):
        if name not in bt or name not in bo:
            out.append(name)
            continue
        if _semantic_key(bt[name]) != _semantic_key(bo[name]):
            out.append(name)
    return out


def _connections_key(conns: List[JSONDict]) -> str:
    def k(c: JSONDict) -> Tuple:
        return (str(c.get("from")), str(c.get("to")), int(c.get("from_output") or 0), int(c.get("to_input") or 0))

    return _json_dump(sorted(conns, key=k))


def evaluate_modify_task(
    *,
    normalizer: WorkflowNormalizer,
    template_wf: JSONDict,
    oracle_wf: JSONDict,
    pred_wf: JSONDict,
    resolved_node_names: Optional[List[str]] = None,
) -> JSONDict:
    """
    Task-focused modify metrics (insert-style gold coverage + untouched non-targets).

    Metrics values are floats in {0.0, 1.0} where applicable for JSONL compatibility.
    """
    base: JSONDict = {
        "modify_n_target_nodes": 0.0,
        "modify_target_node_names": [],
        "modify_targets_type_ok": 0.0,
        "modify_targets_params_ok": 0.0,
        "modify_non_target_nodes_preserved": 0.0,
        "modify_connections_match_oracle": 0.0,
        "modify_no_extra_nodes": 0.0,
        "modify_resolve_matches_oracle": None,
        "modify_success": 0.0,
        "modify_error_type": "pred_invalid",
    }

    if not pred_wf or not isinstance(pred_wf, dict):
        return base
    if "nodes" not in pred_wf or "connections" not in pred_wf:
        return base

    try:
        modified = find_modified_node_names(template_wf, oracle_wf, normalizer)
    except Exception:
        base["modify_error_type"] = "normalize_failed"
        return base

    bt, _ = _nodes_by_name_from_raw(normalizer, template_wf)
    bo, co = _nodes_by_name_from_raw(normalizer, oracle_wf)
    bp, cp = _nodes_by_name_from_raw(normalizer, pred_wf)

    base["modify_n_target_nodes"] = float(len(modified))
    base["modify_target_node_names"] = list(modified)

    if not modified:
        base["modify_error_type"] = "oracle_no_diff"
        return base

    missing_targets = any(name not in bp for name in modified)

    targets_type_ok = True
    targets_params_ok = True
    for name in modified:
        if name not in bp:
            targets_type_ok = False
            targets_params_ok = False
            break
        if name not in bo:
            targets_type_ok = False
            targets_params_ok = False
            break
        if bp[name].get("type") != bo[name].get("type"):
            targets_type_ok = False
        op = bo[name].get("parameters")
        pp = bp[name].get("parameters")
        if isinstance(op, dict):
            if not pred_parameters_cover_gold(op, pp if isinstance(pp, dict) else {}):
                targets_params_ok = False
        elif op not in (None, {}):
            targets_params_ok = False

    non_target_ok = True
    for name, tnode in bt.items():
        if name in modified:
            continue
        if name not in bp:
            non_target_ok = False
            break
        if _semantic_key(tnode) != _semantic_key(bp[name]):
            non_target_ok = False
            break

    extra_names = set(bp.keys()) - set(bt.keys())
    no_extra_ok = len(extra_names) == 0

    conn_ok = _connections_key(cp) == _connections_key(co)

    resolve_ok: Optional[bool] = None
    if resolved_node_names is not None:
        resolve_ok = set(resolved_node_names) == set(modified)
        base["modify_resolve_matches_oracle"] = 1.0 if resolve_ok else 0.0

    base["modify_targets_type_ok"] = 1.0 if targets_type_ok else 0.0
    base["modify_targets_params_ok"] = 1.0 if targets_params_ok else 0.0
    base["modify_non_target_nodes_preserved"] = 1.0 if non_target_ok else 0.0
    base["modify_connections_match_oracle"] = 1.0 if conn_ok else 0.0
    base["modify_no_extra_nodes"] = 1.0 if no_extra_ok else 0.0

    parts = [
        targets_type_ok,
        targets_params_ok,
        non_target_ok,
        conn_ok,
        no_extra_ok,
    ]
    if resolved_node_names is not None:
        parts.append(bool(resolve_ok))

    all_ok = all(parts)
    base["modify_success"] = 1.0 if all_ok else 0.0

    if missing_targets:
        err = "missing_target_node"
    elif not targets_type_ok:
        err = "target_type_mismatch"
    elif not targets_params_ok:
        err = "target_params_not_covering_gold"
    elif not non_target_ok:
        err = "non_target_node_changed"
    elif not no_extra_ok:
        err = "extra_nodes_in_pred"
    elif not conn_ok:
        err = "connections_mismatch"
    elif resolved_node_names is not None and not resolve_ok:
        err = "resolve_mismatch"
    elif all_ok:
        err = "ok_modify_task"
    else:
        err = "modify_partial"

    base["modify_error_type"] = err
    return base


def summarize_modify_metrics(results: List[JSONDict]) -> JSONDict:
    """Aggregate modify_task_* metrics from batch results (each r has 'metrics' dict)."""
    rows = [r for r in results if r.get("metrics") and "modify_success" in r["metrics"]]
    if not rows:
        return {"n": 0, "error": "no_modify_metrics"}

    def mean_key(key: str) -> float:
        xs = [float(r["metrics"][key]) for r in rows if key in r["metrics"] and r["metrics"][key] is not None]
        return sum(xs) / len(xs) if xs else 0.0

    from collections import Counter

    errs = Counter(
        str(r["metrics"].get("modify_error_type") or r.get("modify_error_type") or "unknown") for r in rows
    )
    resolve_rates = [
        float(r["metrics"]["modify_resolve_matches_oracle"])
        for r in rows
        if r["metrics"].get("modify_resolve_matches_oracle") is not None
    ]
    out: JSONDict = {
        "n": len(rows),
        "modify_success_rate": mean_key("modify_success"),
        "targets_type_ok_rate": mean_key("modify_targets_type_ok"),
        "targets_params_ok_rate": mean_key("modify_targets_params_ok"),
        "non_target_preserved_rate": mean_key("modify_non_target_nodes_preserved"),
        "connections_match_oracle_rate": mean_key("modify_connections_match_oracle"),
        "no_extra_nodes_rate": mean_key("modify_no_extra_nodes"),
        "modify_error_counts": dict(errs),
    }
    if resolve_rates:
        out["resolve_matches_oracle_rate"] = sum(resolve_rates) / len(resolve_rates)
    return out
