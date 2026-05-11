from __future__ import annotations

from typing import Any, Dict, Set, Tuple

from .merge import resolve_supplementary_attachment

JSONDict = Dict[str, Any]

_SUPPLEMENTARY_KINDS = frozenset(
    {"supplementary", "tool_for_agent", "langchain_tool", "langchain_attach"}
)


def _declared_type_implies_langchain_tool(declared_node_type: str) -> bool:
    """True if the instruction-declared n8n type is typically wired via ``ai_tool`` (not main)."""
    t = (declared_node_type or "").strip()
    if not t:
        return False
    seg = t.replace("@", "").split(".")[-1].split("/")[-1]
    sl = seg.lower()
    return seg.endswith("Tool") or sl.endswith("tool") or "clienttool" in sl


def _collect_langchain_agent_names(wf: JSONDict) -> Set[str]:
    """
    Names of agent nodes: explicit langchain agent types, and any target of an ``ai_tool`` link.
    """
    agents: Set[str] = set()
    conns = wf.get("connections")
    if isinstance(conns, dict):
        for block in conns.values():
            if not isinstance(block, dict):
                continue
            val = block.get("ai_tool")
            if not isinstance(val, list):
                continue
            for grp in val:
                if not isinstance(grp, list):
                    continue
                for link in grp:
                    if isinstance(link, dict) and link.get("node"):
                        agents.add(str(link["node"]))
    for n in wf.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        nm = n.get("name")
        if not nm:
            continue
        ty = str(n.get("type") or "").lower()
        if "langchain" in ty and "agent" in ty:
            agents.add(str(nm))
        elif ty.endswith(".agent"):
            agents.add(str(nm))
    return agents


def _candidate_agent_for_main_location(loc: JSONDict, agents: Set[str]) -> Optional[str]:
    """If the main-style ``loc`` already names an agent, return that name."""
    kind = str(loc.get("kind") or "").lower()
    if kind == "between":
        pair = loc.get("between")
        if isinstance(pair, list) and len(pair) >= 2:
            a, b = str(pair[0]).strip(), str(pair[1]).strip()
            if b in agents:
                return b
            if a in agents:
                return a
    elif kind == "after":
        af = loc.get("after")
        if isinstance(af, str) and af.strip() in agents:
            return af.strip()
        te = loc.get("to_existing")
        if isinstance(te, str) and te.strip() in agents:
            return te.strip()
    elif kind == "before":
        bf = loc.get("before")
        if isinstance(bf, str) and bf.strip() in agents:
            return bf.strip()
        fs = loc.get("from_source")
        if isinstance(fs, str) and fs.strip() in agents:
            return fs.strip()
    return None


def apply_langchain_tool_location_heuristic(
    template: JSONDict,
    loc: JSONDict,
    *,
    declared_node_type: str,
) -> Tuple[JSONDict, bool]:
    """
    When Phase 0 chose a **main** splice but the declared type is a LangChain-style **tool**
    and the template names a known **agent**, rewrite to ``tool_for_agent`` so ``merge`` uses
    ``ai_tool`` instead of cutting the main edge.

    Returns ``(new_loc, changed)``. If the rewrite would not resolve, returns ``(loc, False)``.
    """
    if not isinstance(loc, dict) or not isinstance(template, dict):
        return loc, False

    kind_l = str(loc.get("kind") or "").lower()
    if kind_l in _SUPPLEMENTARY_KINDS:
        return loc, False
    if str(loc.get("splice_style") or "").lower() == "new_branch" or kind_l == "branch":
        return loc, False

    if not _declared_type_implies_langchain_tool(declared_node_type):
        return loc, False

    agents = _collect_langchain_agent_names(template)
    if not agents:
        return loc, False

    agent_name = _candidate_agent_for_main_location(loc, agents)
    if agent_name is None and len(agents) == 1:
        agent_name = next(iter(agents))

    if agent_name is None or not agent_name:
        return loc, False

    trial = {"kind": "tool_for_agent", "agent": agent_name}
    if resolve_supplementary_attachment(template, trial) is None:
        return loc, False

    return trial, True
