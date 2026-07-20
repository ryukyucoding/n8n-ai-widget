"""Insert-task evaluation (extracted from n8n_workflow_generator_package)."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Tuple

from insert.workflow_utils import (
    extract_first_json_object,
    json_dump,
    normalize_workflow,
    workflow_has_dangling_connections,
    workflow_node_names,
)

JSONDict = Dict[str, Any]


def token_set(text: str) -> set:
    return {t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_-]{2,}", text)}


def workflow_node_by_name(wf: JSONDict, name: str) -> Optional[JSONDict]:
    for node in wf.get("nodes") or []:
        if isinstance(node, dict) and node.get("name") == name:
            return node
    return None


def main_outgoing_targets(wf: JSONDict, source: str) -> List[str]:
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        return []
    block = conns.get(source)
    if not isinstance(block, dict):
        return []
    main = block.get("main")
    if not isinstance(main, list):
        return []
    acc: List[str] = []
    for group in main:
        if not isinstance(group, list):
            continue
        for link in group:
            if isinstance(link, dict) and link.get("node"):
                acc.append(str(link["node"]))
    return acc


def main_incoming_sources(wf: JSONDict, target: str) -> List[str]:
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        return []
    srcs: List[str] = []
    for src, block in conns.items():
        if not isinstance(block, dict):
            continue
        main = block.get("main")
        if not isinstance(main, list):
            continue
        for group in main:
            if not isinstance(group, list):
                continue
            for link in group:
                if isinstance(link, dict) and str(link.get("node")) == target:
                    srcs.append(str(src))
    return srcs


def main_neighbor_signature(wf: JSONDict, node: str) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
    inc = main_incoming_sources(wf, node)
    out = main_outgoing_targets(wf, node)
    return (tuple(sorted(inc)), tuple(sorted(out)))


def is_vacuous_cover_value(value: Any) -> bool:
    return value is None or value == {} or value == []


def normalize_for_params_cover(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        low = s.lower()
        if low == "true":
            return True
        if low == "false":
            return False
        if (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]")):
            try:
                return normalize_for_params_cover(json.loads(s))
            except (json.JSONDecodeError, TypeError, ValueError):
                return value
        return value
    if isinstance(value, list):
        return [normalize_for_params_cover(x) for x in value]
    if isinstance(value, dict):
        return {str(k): normalize_for_params_cover(v) for k, v in value.items()}
    return value


def pred_parameters_cover_gold(gold: Any, pred: Any) -> bool:
    g = normalize_for_params_cover(gold)
    p = normalize_for_params_cover(pred)
    if g == p:
        return True
    if g is None:
        return True
    if isinstance(g, dict) and isinstance(p, dict):
        for key, gv in g.items():
            gkn = normalize_for_params_cover(gv)
            if key not in p:
                if is_vacuous_cover_value(gkn):
                    continue
                return False
            if not pred_parameters_cover_gold(gv, p[key]):
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


@dataclass
class InsertEvalResult:
    ok_kind: bool
    ok_parse_wf: Optional[bool]
    strict_match: bool
    relaxed_match: bool
    inserted_node_ok: Optional[bool]
    inserted_node_name_ok: Optional[bool]
    inserted_node_type_ok: Optional[bool]
    insert_main_neighbors_ok: Optional[bool]
    gold_params_subset_ok: Optional[bool]
    ok_no_dangling: Optional[bool]
    ok_has_connections: Optional[bool]
    ask_token_recall: Optional[float]
    error_type: str

    def to_json(self) -> JSONDict:
        return asdict(self)


def pred_is_workflow_json_response(raw: Optional[str], pred_wf: Optional[JSONDict]) -> bool:
    if pred_wf is None or not raw:
        return False
    text = raw.strip()
    if not text.startswith("{"):
        return False
    try:
        dumped = json.dumps(pred_wf, ensure_ascii=False)
        return len(text) <= len(dumped) * 1.05 + 20
    except Exception:
        return True


def evaluate_insert(
    *,
    oracle_out: Any,
    clue: JSONDict,
    pred_raw: Optional[str],
) -> InsertEvalResult:
    oracle_ask = clue.get("output_kind") == "ask"
    pred_wf = extract_first_json_object(pred_raw or "")
    inserted = str(clue.get("inserted_node_name") or "")

    if oracle_ask:
        got_wf = pred_is_workflow_json_response(pred_raw, pred_wf)
        if got_wf:
            return InsertEvalResult(
                ok_kind=False,
                ok_parse_wf=None,
                strict_match=False,
                relaxed_match=False,
                inserted_node_ok=None,
                inserted_node_name_ok=None,
                inserted_node_type_ok=None,
                insert_main_neighbors_ok=None,
                gold_params_subset_ok=None,
                ok_no_dangling=None,
                ok_has_connections=None,
                ask_token_recall=None,
                error_type="ask_got_workflow_json",
            )
        ot = token_set(str(oracle_out))
        pt = token_set(pred_raw or "")
        recall = (len(ot & pt) / len(ot)) if ot else 0.0
        raw = (pred_raw or "").strip()
        heuristic_ok = len(raw) > 30 and (
            "?" in raw or "parameter" in raw.lower() or "provide" in raw.lower() or "value" in raw.lower()
        )
        ok_kind = heuristic_ok or recall >= 0.08
        err = "ok_ask" if ok_kind else "ask_weak"
        if recall >= 0.15 and heuristic_ok:
            err = "ok_ask"
        elif recall >= 0.12:
            err = "ok_ask"
        return InsertEvalResult(
            ok_kind=ok_kind,
            ok_parse_wf=False,
            strict_match=False,
            relaxed_match=False,
            inserted_node_ok=None,
            inserted_node_name_ok=None,
            inserted_node_type_ok=None,
            insert_main_neighbors_ok=None,
            gold_params_subset_ok=None,
            ok_no_dangling=None,
            ok_has_connections=None,
            ask_token_recall=recall,
            error_type=err,
        )

    if not isinstance(oracle_out, dict):
        return InsertEvalResult(
            ok_kind=True,
            ok_parse_wf=False,
            strict_match=False,
            relaxed_match=False,
            inserted_node_ok=None,
            inserted_node_name_ok=None,
            inserted_node_type_ok=None,
            insert_main_neighbors_ok=None,
            gold_params_subset_ok=None,
            ok_no_dangling=None,
            ok_has_connections=None,
            ask_token_recall=None,
            error_type="oracle_not_dict",
        )

    if pred_wf is None:
        return InsertEvalResult(
            ok_kind=True,
            ok_parse_wf=False,
            strict_match=False,
            relaxed_match=False,
            inserted_node_ok=None,
            inserted_node_name_ok=None,
            inserted_node_type_ok=None,
            insert_main_neighbors_ok=None,
            gold_params_subset_ok=None,
            ok_no_dangling=None,
            ok_has_connections=None,
            ask_token_recall=None,
            error_type="parse_failed",
        )

    strict_match = json_dump(normalize_workflow(pred_wf, relaxed=False)) == json_dump(
        normalize_workflow(oracle_out, relaxed=False)
    )
    relaxed_match = json_dump(normalize_workflow(pred_wf, relaxed=True)) == json_dump(
        normalize_workflow(oracle_out, relaxed=True)
    )

    names = set(workflow_node_names(pred_wf))
    inserted_node_name_ok = bool(inserted) and inserted in names
    on = workflow_node_by_name(oracle_out, inserted) if inserted else None
    pn = workflow_node_by_name(pred_wf, inserted) if inserted_node_name_ok else None
    if inserted_node_name_ok and isinstance(on, dict) and isinstance(pn, dict):
        inserted_node_type_ok = on.get("type") == pn.get("type")
    else:
        inserted_node_type_ok = False
    inserted_node_ok = bool(inserted_node_name_ok and inserted_node_type_ok)

    if not inserted_node_name_ok:
        insert_main_neighbors_ok = False
    else:
        insert_main_neighbors_ok = main_neighbor_signature(oracle_out, inserted) == main_neighbor_signature(
            pred_wf, inserted
        )

    ok_has_connections = isinstance(pred_wf.get("connections"), dict)
    ok_no_dangling = not workflow_has_dangling_connections(pred_wf)

    gold_params_subset_ok: Optional[bool] = None
    if inserted and inserted_node_name_ok and isinstance(on, dict) and isinstance(pn, dict):
        gp = on.get("parameters")
        pp = pn.get("parameters")
        if isinstance(gp, dict):
            gold_params_subset_ok = pred_parameters_cover_gold(gp, pp) if isinstance(pp, dict) else False
        else:
            gold_params_subset_ok = True

    if strict_match:
        err = "ok_strict"
    elif relaxed_match:
        err = "ok_relaxed"
    elif not ok_has_connections:
        err = "missing_connections"
    elif not inserted_node_name_ok:
        err = "inserted_node_missing"
    elif not inserted_node_type_ok:
        err = "inserted_type_mismatch"
    elif not insert_main_neighbors_ok:
        err = "insert_splice_mismatch"
    elif not ok_no_dangling:
        err = "dangling_connections"
    elif gold_params_subset_ok is True:
        err = "ok_insert_params_cover_gold"
    else:
        err = "mismatch_other"

    return InsertEvalResult(
        ok_kind=True,
        ok_parse_wf=True,
        strict_match=strict_match,
        relaxed_match=relaxed_match,
        inserted_node_ok=inserted_node_ok,
        inserted_node_name_ok=inserted_node_name_ok,
        inserted_node_type_ok=inserted_node_type_ok,
        insert_main_neighbors_ok=insert_main_neighbors_ok,
        gold_params_subset_ok=gold_params_subset_ok,
        ok_no_dangling=ok_no_dangling,
        ok_has_connections=ok_has_connections,
        ask_token_recall=None,
        error_type=err,
    )
