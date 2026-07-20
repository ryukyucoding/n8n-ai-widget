"""Score creation (from-scratch) predictions vs gold."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

from scoring import setup_path

setup_path()

from evaluation.comparison.node_matcher import NodeMatcher
from evaluation.comparison.workflow_normalizer import WorkflowNormalizer
from evaluation.evaluators.llm_json_validity import llm_output_json_validity_metrics
from evaluation.evaluators.node_accuracy_evaluator import NodeAccuracyEvaluator

JSONDict = Dict[str, Any]


def _f1(precision: float, recall: float) -> float:
    if precision + recall <= 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def _connections_to_type_set(
    connections: List[JSONDict], name_to_type: Dict[str, str]
) -> Set[Tuple[str, str]]:
    out: Set[Tuple[str, str]] = set()
    for conn in connections:
        src = conn.get("from") or conn.get("source") or ""
        dst = conn.get("to") or conn.get("target") or ""
        from_type = name_to_type.get(src)
        to_type = name_to_type.get(dst)
        if from_type and to_type:
            out.add((from_type, to_type))
    return out


def evaluate_matched_connections(
    gt_norm: JSONDict, llm_norm: JSONDict, matching: JSONDict
) -> JSONDict:
    matched_gt_names = {m["gt_node"]["name"] for m in matching.get("matches") or []}
    matched_llm_names = {m["llm_node"]["name"] for m in matching.get("matches") or []}

    gt_nt = {n["name"]: n["type"] for n in gt_norm.get("nodes") or []}
    llm_nt = {n["name"]: n["type"] for n in llm_norm.get("nodes") or []}

    gt_conns = [
        c
        for c in gt_norm.get("connections") or []
        if c.get("from") in matched_gt_names and c.get("to") in matched_gt_names
    ]
    llm_conns = [
        c
        for c in llm_norm.get("connections") or []
        if c.get("from") in matched_llm_names and c.get("to") in matched_llm_names
    ]

    gt_set = _connections_to_type_set(gt_conns, gt_nt)
    llm_set = _connections_to_type_set(llm_conns, llm_nt)
    correct = len(gt_set & llm_set)
    prec = correct / len(llm_set) if llm_set else 0.0
    rec = correct / len(gt_set) if gt_set else 0.0
    return {
        "matched_connection_precision": prec,
        "matched_connection_recall": rec,
        "matched_connection_f1": _f1(prec, rec),
        "matched_gt_connection_count": len(gt_set),
        "matched_llm_connection_count": len(llm_set),
        "matched_correct_connections": correct,
    }


def evaluate_creation(
    gold: JSONDict,
    pred: JSONDict,
    *,
    skip_parameter_eval: bool = False,
    embedding_model: str = "paraphrase-multilingual-mpnet-base-v2",
    param_threshold: float = 0.8,
) -> JSONDict:
    normalizer = WorkflowNormalizer()
    matcher = NodeMatcher()
    node_eval = NodeAccuracyEvaluator()

    template = {"metadata": {"id": "gold"}, "workflow": {"workflow": gold}}
    gt_norm = normalizer.normalize_ground_truth(template)
    llm_norm = normalizer.normalize_llm_output(pred)

    matching = matcher.match_nodes(gt_norm["nodes"], llm_norm["nodes"])
    node_metrics = node_eval.evaluate_node_types(matching)
    conn_metrics = node_eval.evaluate_connections(gt_norm, llm_norm)
    matched_conn = evaluate_matched_connections(gt_norm, llm_norm, matching)

    param_metrics: JSONDict = {"avg_parameter_accuracy": 0.0, "per_node_accuracy": []}
    if not skip_parameter_eval and matching.get("matches"):
        try:
            from evaluation.evaluators.parameter_evaluator import ParameterEvaluator

            pe = ParameterEvaluator(model_name=embedding_model, threshold=param_threshold)
            param_metrics = pe.evaluate_parameters(matching)
        except Exception as exc:
            param_metrics = {
                "avg_parameter_accuracy": 0.0,
                "per_node_accuracy": [],
                "parameter_eval_error": str(exc),
            }

    json_metrics = llm_output_json_validity_metrics({"llm_response": pred})

    metrics = {
        **node_metrics,
        **conn_metrics,
        **matched_conn,
        **param_metrics,
        **json_metrics,
    }

    return {
        "success": bool(metrics.get("node_type_f1", 0) > 0 or metrics.get("connection_f1", 0) > 0),
        "primary_metric": "creation_workflow",
        "metrics": metrics,
        "summary": {
            "node_f1": round(float(metrics.get("node_type_f1") or 0), 4),
            "connection_f1": round(float(metrics.get("connection_f1") or 0), 4),
            "matched_connection_f1": round(float(metrics.get("matched_connection_f1") or 0), 4),
            "parameter_accuracy": round(float(metrics.get("avg_parameter_accuracy") or 0), 4),
            "gt_functional_nodes": int(metrics.get("gt_node_count") or 0),
            "pred_functional_nodes": int(metrics.get("llm_node_count") or 0),
        },
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Score creation prediction vs gold workflow")
    ap.add_argument("--gold", type=Path, required=True)
    ap.add_argument("--pred", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--skip-parameter-eval", action="store_true")
    args = ap.parse_args(argv)

    gold = json.loads(args.gold.read_text(encoding="utf-8"))
    pred = json.loads(args.pred.read_text(encoding="utf-8"))

    try:
        result = evaluate_creation(gold, pred, skip_parameter_eval=args.skip_parameter_eval)
    except Exception as exc:
        result = {"success": False, "error": str(exc), "metrics": {}}

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
