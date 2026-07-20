#!/usr/bin/env python3
"""
Deletion-task evaluation (task-focused, same spirit as modify_task).

Uses template (pre-delete) and oracle (post-delete) to derive intended removals
(template node names minus oracle node names), then scores predictions on:
  - every target removed from the graph
  - no extra removals (only intended names disappear)
  - surviving nodes match oracle semantics (type + parameters in normalizer space)
  - normalized main connections match oracle
  - optional: resolved_node_names set equals oracle removal set
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Dict, List, Optional, Set

from evaluation.comparison.workflow_normalizer import WorkflowNormalizer
from evaluation.evaluators.modify_task_evaluator import (
    _connections_key,
    _nodes_by_name_from_raw,
    _semantic_key,
)

JSONDict = Dict[str, Any]


def raw_node_names(wf: JSONDict) -> Set[str]:
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        return set()
    out: Set[str] = set()
    for n in nodes:
        if isinstance(n, dict) and isinstance(n.get("name"), str) and n["name"].strip():
            out.add(str(n["name"]))
    return out


def expected_removals_from_gold(template_wf: JSONDict, oracle_wf: JSONDict) -> Set[str]:
    return raw_node_names(template_wf) - raw_node_names(oracle_wf)


def evaluate_delete_task(
    *,
    normalizer: WorkflowNormalizer,
    template_wf: JSONDict,
    oracle_wf: JSONDict,
    pred_wf: JSONDict,
    expected_removal_names: Optional[Set[str]] = None,
    resolved_node_names: Optional[List[str]] = None,
) -> JSONDict:
    """
    Returns metrics with floats in {0.0, 1.0} and delete_error_type.
    """
    base: JSONDict = {
        "delete_n_target_nodes": 0.0,
        "delete_target_node_names": [],
        "delete_targets_removed": 0.0,
        "delete_only_intended_removed": 0.0,
        "delete_survivors_match_oracle": 0.0,
        "delete_connections_match_oracle": 0.0,
        "delete_no_extra_raw_nodes": 0.0,
        "delete_resolve_matches_oracle": None,
        "delete_success": 0.0,
        "delete_error_type": "pred_invalid",
    }

    er: Set[str] = set(expected_removal_names) if expected_removal_names is not None else expected_removals_from_gold(
        template_wf, oracle_wf
    )
    base["delete_n_target_nodes"] = float(len(er))
    base["delete_target_node_names"] = sorted(er)

    if not pred_wf or not isinstance(pred_wf, dict):
        return base
    if "nodes" not in pred_wf or "connections" not in pred_wf:
        base["delete_error_type"] = "pred_invalid"
        return base

    try:
        bo, co = _nodes_by_name_from_raw(normalizer, oracle_wf)
        bp, cp = _nodes_by_name_from_raw(normalizer, pred_wf)
    except Exception:
        base["delete_error_type"] = "normalize_failed"
        return base

    t_raw = raw_node_names(template_wf)
    p_raw = raw_node_names(pred_wf)
    o_raw = raw_node_names(oracle_wf)

    if not er and t_raw == o_raw:
        base["delete_error_type"] = "oracle_no_removal"
        base["delete_success"] = 0.0
        return base

    removed_raw = t_raw - p_raw
    targets_removed = er.isdisjoint(p_raw)
    only_intended = removed_raw == er
    raw_names_match_oracle = p_raw == o_raw

    survivors_match = True
    for name in sorted(bo.keys()):
        if name not in bp:
            survivors_match = False
            break
        if _semantic_key(bp[name]) != _semantic_key(bo[name]):
            survivors_match = False
            break

    conn_ok = _connections_key(cp) == _connections_key(co)

    resolve_ok: Optional[bool] = None
    if resolved_node_names is not None:
        resolve_ok = set(resolved_node_names) == er
        base["delete_resolve_matches_oracle"] = 1.0 if resolve_ok else 0.0

    base["delete_targets_removed"] = 1.0 if targets_removed else 0.0
    base["delete_only_intended_removed"] = 1.0 if only_intended else 0.0
    base["delete_survivors_match_oracle"] = 1.0 if survivors_match else 0.0
    base["delete_connections_match_oracle"] = 1.0 if conn_ok else 0.0
    base["delete_no_extra_raw_nodes"] = 1.0 if raw_names_match_oracle else 0.0

    parts = [
        targets_removed,
        only_intended,
        survivors_match,
        conn_ok,
        raw_names_match_oracle,
    ]
    if resolved_node_names is not None:
        parts.append(bool(resolve_ok))

    all_ok = all(parts)
    base["delete_success"] = 1.0 if all_ok else 0.0

    if not targets_removed:
        err = "target_still_present"
    elif not only_intended:
        err = "wrong_or_incomplete_removal"
    elif not survivors_match:
        err = "survivor_semantic_drift"
    elif not conn_ok:
        err = "connections_mismatch"
    elif not raw_names_match_oracle:
        err = "node_set_mismatch"
    elif resolved_node_names is not None and not resolve_ok:
        err = "resolve_mismatch"
    elif all_ok:
        err = "ok_delete_task"
    else:
        err = "delete_partial"

    base["delete_error_type"] = err
    return base


def summarize_delete_metrics(results: List[JSONDict]) -> JSONDict:
    rows = [r for r in results if r.get("metrics") and "delete_success" in r["metrics"]]
    if not rows:
        return {"n": 0, "error": "no_delete_metrics"}

    def mean_key(key: str) -> float:
        xs = [
            float(r["metrics"][key])
            for r in rows
            if key in r["metrics"] and r["metrics"][key] is not None
        ]
        return sum(xs) / len(xs) if xs else 0.0

    errs = Counter(str(r["metrics"].get("delete_error_type") or "unknown") for r in rows)
    resolve_rates = [
        float(r["metrics"]["delete_resolve_matches_oracle"])
        for r in rows
        if r["metrics"].get("delete_resolve_matches_oracle") is not None
    ]
    out: JSONDict = {
        "n": len(rows),
        "delete_success_rate": mean_key("delete_success"),
        "targets_removed_rate": mean_key("delete_targets_removed"),
        "only_intended_removed_rate": mean_key("delete_only_intended_removed"),
        "survivors_match_oracle_rate": mean_key("delete_survivors_match_oracle"),
        "connections_match_oracle_rate": mean_key("delete_connections_match_oracle"),
        "node_set_match_oracle_rate": mean_key("delete_no_extra_raw_nodes"),
        "delete_error_counts": dict(errs),
    }
    if resolve_rates:
        out["resolve_matches_oracle_rate"] = sum(resolve_rates) / len(resolve_rates)
    return out
