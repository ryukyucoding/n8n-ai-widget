"""Programmatic removal of n8n workflow node(s) with splice (rewire through deleted nodes).

Matches typical n8n editor behavior for the main workflow: when deleting B in A→B→C,
rewire to A→C using the successor link metadata from B→C, not merely dropping edges."""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Set

JSONDict = Dict[str, Any]


def _deepcopy_link(link: JSONDict) -> JSONDict:
    return copy.deepcopy(link)


def _outgoing_neighbor_names(conns: JSONDict, source: str) -> Set[str]:
    """Names reachable by one hop from ``source`` in n8n connection dict."""
    out: Set[str] = set()
    block = conns.get(str(source))
    if not isinstance(block, dict):
        return out
    for val in block.values():
        if not isinstance(val, list):
            continue
        for group in val:
            if not isinstance(group, list):
                continue
            for link in group:
                if isinstance(link, dict) and link.get("node"):
                    out.add(str(link["node"]))
    return out


def _pick_removal_order(names: Set[str], conns: JSONDict) -> List[str]:
    """
    Among nodes to delete, drop **leaves of the induced subgraph** first so that
    e.g. A→B→C with removals {B,C} processes C before B.
    Falls back deterministically when a cycle exists among removals.
    """
    remaining = set(names)
    order: List[str] = []
    while remaining:
        chosen: Optional[str] = None
        for cand in sorted(remaining):
            nbrs = _outgoing_neighbor_names(conns, cand)
            if not (nbrs & remaining):
                chosen = cand
                break
        if chosen is None:
            chosen = min(remaining)
        order.append(chosen)
        remaining.remove(chosen)
    return order


def _first_non_empty_groups(block_b: JSONDict, channel: str) -> Optional[List[Any]]:
    groups = block_b.get(channel)
    if not isinstance(groups, list):
        return None
    for g in groups:
        if isinstance(g, list) and g:
            return g
    return None


def _successor_links_for_incoming(block_b: JSONDict, incoming_link: JSONDict) -> List[JSONDict]:
    """
    Incoming edge to deleted node ``B``: use the corresponding output port on ``B``.
    Falls back when index is absent, out of range, or channel missing (try ``main``).
    """
    channel = incoming_link.get("type") or "main"
    idx_raw = incoming_link.get("index", 0)
    try:
        idx = int(idx_raw if idx_raw is not None else 0)
    except (TypeError, ValueError):
        idx = 0

    def from_groups(groups: Any) -> Optional[List[JSONDict]]:
        if not isinstance(groups, list):
            return None
        if 0 <= idx < len(groups) and groups[idx]:
            g = groups[idx]
            if isinstance(g, list):
                return [_deepcopy_link(x) for x in g if isinstance(x, dict)]
        for g in groups:
            if isinstance(g, list) and g:
                return [_deepcopy_link(x) for x in g if isinstance(x, dict)]
        return None

    resolved = from_groups(block_b.get(channel))
    if resolved is not None:
        return resolved
    if channel != "main":
        main_g = from_groups(block_b.get("main"))
        if main_g is not None:
            return main_g
        # Any other channel with edges
        for ck, groups in block_b.items():
            if ck == channel:
                continue
            resolved = from_groups(groups)
            if resolved is not None:
                return resolved
    return []


def _rewrite_group_remove_target(
    group: Any,
    b: str,
    block_b: JSONDict,
) -> List[Any]:
    if not isinstance(group, list):
        return [group]
    new_group: List[Any] = []
    for link in group:
        if not isinstance(link, dict):
            new_group.append(link)
            continue
        tgt = str(link.get("node", "") or "")
        if tgt == b:
            new_group.extend(_successor_links_for_incoming(block_b, link))
        else:
            new_group.append(link)
    return new_group


def remove_nodes_from_workflow(workflow: JSONDict, names_to_remove: Set[str]) -> JSONDict:
    """
    Deep-copy ``workflow``, remove listed nodes with **splice** (oracle-like): any edge
    into a removed node ``B`` is replaced by edges to ``B``'s successors (using ``B``'s
    connection payloads), analogous to deleting in the n8n editor.

    Ordering: among multiple removals, drop **leaves** of the induced subgraph first
    (computed on the original workflow's ``connections``).
    """
    if not names_to_remove:
        return copy.deepcopy(workflow)

    to_remove = {str(x) for x in names_to_remove if x}
    out = copy.deepcopy(workflow)
    nodes = out.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("workflow.nodes must be a list")

    initial_conns = out.get("connections") if isinstance(out.get("connections"), dict) else {}

    remove_order = _pick_removal_order(set(to_remove), dict(initial_conns))

    for bname in remove_order:
        names_now = [
            str(n.get("name", ""))
            for n in (out.get("nodes") or [])
            if isinstance(n, dict) and n.get("name")
        ]
        raw_conns = out.get("connections")
        if not isinstance(raw_conns, dict):
            raw_conns = {}
            out["connections"] = raw_conns

        if bname not in names_now:
            raw_conns.pop(bname, None)
            continue

        block_b_snap = (
            copy.deepcopy(raw_conns[bname])
            if isinstance(raw_conns.get(bname), dict)
            else {}
        )

        _splice_remove_one_using_block(out, bname, block_b_snap)

        out["nodes"] = [
            n
            for n in (out.get("nodes") or [])
            if isinstance(n, dict) and str(n.get("name", "")) != bname
        ]

        pin = out.get("pinData")
        if isinstance(pin, dict) and bname in pin:
            del pin[bname]

    return out


def _splice_remove_one_using_block(out: JSONDict, b: str, block_b: JSONDict) -> None:
    """Rewrite using ``block_b`` (snapshot of ``connections[b]``) then remove connection key ``b``."""
    conns = out.get("connections")
    if not isinstance(conns, dict):
        conns = {}
        out["connections"] = conns

    for src in list(conns.keys()):
        if src == str(b):
            continue
        blk = conns.get(src)
        if not isinstance(blk, dict):
            continue
        new_blk: JSONDict = {}
        for out_type, out_lists in blk.items():
            if not isinstance(out_lists, list):
                new_blk[out_type] = out_lists
                continue
            new_lists = [
                _rewrite_group_remove_target(g, str(b), block_b) if isinstance(g, list) else g
                for g in out_lists
            ]
            new_blk[out_type] = new_lists
        conns[str(src)] = new_blk

    conns.pop(str(b), None)


def names_exist_in_workflow(workflow: JSONDict, names: List[str]) -> List[str]:
    """Return names from ``names`` that are missing from ``workflow.nodes``."""
    have: Set[str] = set()
    for n in workflow.get("nodes") or []:
        if isinstance(n, dict) and n.get("name"):
            have.add(str(n["name"]))
    missing: List[str] = []
    for x in names:
        if x and str(x) not in have:
            missing.append(str(x))
    return missing
