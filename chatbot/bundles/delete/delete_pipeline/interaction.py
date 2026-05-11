"""
Post-LLM interaction: type disambiguation (multiple nodes of same type) and confirm-to-delete.
Batch/eval can simulate with ``expected_removal_names`` (oracle) + auto-confirm.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

from .sticky import is_sticky_note_node

JSONDict = Dict[str, Any]

# e.g. n8n-nodes-base.code, n8n-nodes-base.aggregate, @n8n/n8n-nodes-langchain.xxx
_RE_TECH_TYPE = re.compile(
    r"(n8n-nodes-[\w]+(?:\.[\w]+)*|@n8n/[\w./-]+(?:\.[\w]+)*)",
    re.IGNORECASE,
)


def _non_sticky_node_dicts(wf: JSONDict) -> List[JSONDict]:
    out: List[JSONDict] = []
    for n in wf.get("nodes") or []:
        if isinstance(n, dict) and n.get("name") and not is_sticky_note_node(n):
            out.append(n)
    return out


def _nodes_by_type_name(wf: JSONDict) -> Dict[str, List[str]]:
    m: Dict[str, List[str]] = {}
    for n in _non_sticky_node_dicts(wf):
        t = str(n.get("type", ""))
        m.setdefault(t, []).append(str(n["name"]))
    for k in m:
        m[k] = sorted(set(m[k]))
    return m


def instruction_has_exact_display_name(instruction: str, name: str) -> bool:
    if not name or not instruction:
        return False
    return str(name) in str(instruction)


def find_type_disambiguation(
    workflow: JSONDict, user_instruction: str
) -> Optional[JSONDict]:
    """
    If the instruction names a *technical* node type and there is more than one **non-sticky**
    node of that type, the user should be asked to pick one.

    Returns ``None`` if no such situation; otherwise
    { "node_type": str, "candidate_names": [str, ...] }.
    """
    s = (user_instruction or "").strip()
    if not s:
        return None
    types_found = _RE_TECH_TYPE.findall(s)
    if not types_found:
        return None
    byt = _nodes_by_type_name(workflow)
    for t in types_found:
        t = t.strip()
        cands = byt.get(t)
        if cands and len(cands) > 1:
            named = [n for n in cands if instruction_has_exact_display_name(s, n)]
            if len(named) == 1:
                return None
            return {"node_type": t, "candidate_names": cands}
    return None


def pick_name_from_oracle(
    candidate_names: List[str], oracle_names: Set[str]
) -> Optional[str]:
    inter = [x for x in candidate_names if x in oracle_names]
    if len(inter) == 1:
        return inter[0]
    return None


def apply_deletion_interaction(
    workflow: JSONDict,
    user_instruction: str,
    llm_resolved_names: List[str],
    *,
    expected_removal_names: Optional[Set[str]] = None,
    simulate_user_confirm: bool = True,
) -> Tuple[List[str], JSONDict]:
    """
    Decide final node names to delete and record interaction kind for product / metrics.

    - **Type picker** when a technical type appears in the instruction, 2+ non-sticky
      nodes of that type, and the instruction does not name one display name uniquely.
    - **Confirm** (product): always offered before delete; in eval, ``simulate_user_confirm`` True.

    If type disambiguation is required and there is no oracle and no resolvable LLM pick,
    returns ``[]`` and ``type_disambiguation_unresolved`` in the report.
    """
    report: JSONDict = {
        "would_ask_type_picker": False,
        "type_picker": None,
        "llm_suggested_names": list(llm_resolved_names),
        "type_disambiguation_unresolved": False,
    }
    ex = set(expected_removal_names) if expected_removal_names else set()

    td = find_type_disambiguation(workflow, user_instruction)
    names = list(dict.fromkeys(llm_resolved_names))

    if td and td.get("candidate_names"):
        cands = list(td["candidate_names"])
        report["would_ask_type_picker"] = True
        report["type_picker"] = {
            "node_type": td.get("node_type"),
            "candidate_names": cands,
        }
        if ex:
            pick = pick_name_from_oracle(cands, ex)
            if pick is not None:
                names = [pick]
                report["simulated_type_pick"] = pick
            else:
                o = ex & set(cands)
                if len(o) == 1:
                    only = list(o)[0]
                    names = [only]
                    report["simulated_type_pick"] = only
        else:
            ok = [n for n in names if n in cands]
            if len(ok) == 1:
                names = ok
                report["used_llm_pick_in_candidates"] = ok[0]
            elif len(ok) > 1:
                names = [ok[0]]
                report["used_llm_pick_in_candidates"] = ok[0]
            else:
                report["type_disambiguation_unresolved"] = True
                names = []

    if report.get("type_disambiguation_unresolved"):
        report["would_show_confirm_delete"] = False
        return names, report

    report["would_show_confirm_delete"] = bool(names)
    report["simulated_user_confirmed"] = bool(simulate_user_confirm and names)
    if names and not simulate_user_confirm:
        report["awaiting_user_confirm"] = True

    return names, report
