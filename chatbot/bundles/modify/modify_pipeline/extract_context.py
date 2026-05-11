from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Set

JSONDict = Dict[str, Any]


def _outgoing_all_targets(wf: JSONDict, source: str) -> List[str]:
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        return []
    block = conns.get(source)
    if not isinstance(block, dict):
        return []
    acc: List[str] = []
    for _out_type, out_lists in block.items():
        if not isinstance(out_lists, list):
            continue
        for group in out_lists:
            if not isinstance(group, list):
                continue
            for link in group:
                if isinstance(link, dict) and link.get("node"):
                    acc.append(str(link["node"]))
    return acc


def _incoming_sources(wf: JSONDict, target: str) -> List[str]:
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        return []
    srcs: List[str] = []
    for src, block in conns.items():
        if not isinstance(block, dict):
            continue
        for _out_type, out_lists in block.items():
            if not isinstance(out_lists, list):
                continue
            for group in out_lists:
                if not isinstance(group, list):
                    continue
                for link in group:
                    if isinstance(link, dict) and str(link.get("node")) == target:
                        srcs.append(str(src))
    return srcs


def _node_by_name(wf: JSONDict, name: str) -> Optional[JSONDict]:
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        return None
    for n in nodes:
        if isinstance(n, dict) and n.get("name") == name:
            return n
    return None


def neighbor_names(wf: JSONDict, node_name: str) -> Set[str]:
    s: Set[str] = set()
    s.update(_incoming_sources(wf, node_name))
    s.update(_outgoing_all_targets(wf, node_name))
    return s


def _slice_connection_block(block: Any, names: Set[str]) -> Any:
    if not isinstance(block, dict):
        return block
    out: JSONDict = {}
    for out_type, out_lists in block.items():
        if not isinstance(out_lists, list):
            out[out_type] = out_lists
            continue
        new_lists: List[Any] = []
        for group in out_lists:
            if not isinstance(group, list):
                new_lists.append(group)
                continue
            new_group: List[JSONDict] = []
            for link in group:
                if not isinstance(link, dict):
                    continue
                t = str(link.get("node", ""))
                if t in names:
                    new_group.append(copy.deepcopy(link))
            new_lists.append(new_group)
        out[str(out_type)] = new_lists
    return out


def subgraph_connections(wf: JSONDict, names: Set[str]) -> JSONDict:
    """
    For each source node in ``names``, copy its connection block, keeping only
    links whose target is also in ``names`` (all output types: main, ai_*, etc.).
    """
    full = wf.get("connections")
    if not isinstance(full, dict):
        return {}
    out: JSONDict = {}
    for src in names:
        if str(src) not in full:
            continue
        block = full.get(str(src))
        out[str(src)] = _slice_connection_block(block, names)
    return out


def extract_target_and_neighbors(workflow: JSONDict, target_name: str) -> JSONDict:
    """
    Build context for the modify-phase LLM:

    - ``target_node``: full node (copy)
    - ``neighbor_nodes``: 1-hop neighbors' full node objects
    - ``relevant_connections``: connection subgraph on {target} ∪ neighbors
    """
    wf = copy.deepcopy(workflow)
    target = _node_by_name(wf, target_name)
    if not target:
        return {
            "error": f'no node named "{target_name}"',
            "target_node": None,
            "neighbor_nodes": [],
            "relevant_connections": {},
        }

    nbr = neighbor_names(wf, target_name)
    names: Set[str] = {str(target_name)} | {str(x) for x in nbr}

    relevant = subgraph_connections(wf, names)
    neighbors: List[JSONDict] = []
    nodes = wf.get("nodes")
    if isinstance(nodes, list):
        for n in nodes:
            if not isinstance(n, dict):
                continue
            nm = n.get("name")
            if nm in nbr:
                neighbors.append(copy.deepcopy(n))

    return {
        "target_name": str(target_name),
        "target_node": copy.deepcopy(target),
        "neighbor_nodes": neighbors,
        "relevant_connections": copy.deepcopy(relevant),
    }
