"""
Structured graph / canvas hints for LLM resolve (deletion), derived from workflow JSON.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List, Set

from .sticky import is_sticky_note_node

JSONDict = Dict[str, Any]


def connection_edges_list(wf: JSONDict) -> List[JSONDict]:
    out: List[JSONDict] = []
    c = wf.get("connections")
    if not isinstance(c, dict):
        return out
    for src, block in c.items():
        if not isinstance(block, dict):
            continue
        for _ot, ols in block.items():
            if not isinstance(ols, list):
                continue
            for group in ols:
                if not isinstance(group, list):
                    continue
                for link in group:
                    if isinstance(link, dict) and link.get("node"):
                        out.append({"from": str(src), "to": str(link["node"])})
    return out


def _pred_succ_from_edges(edges: List[JSONDict]) -> tuple[Dict[str, Set[str]], Dict[str, Set[str]]]:
    pred: Dict[str, Set[str]] = defaultdict(set)
    succ: Dict[str, Set[str]] = defaultdict(set)
    for e in edges:
        a, b = str(e.get("from", "")), str(e.get("to", ""))
        if not a or not b:
            continue
        succ[a].add(b)
        pred[b].add(a)
    return pred, succ


def build_deletion_resolve_extras(wf: JSONDict) -> JSONDict:
    """
    Fields merged into the resolve user JSON (``user_instruction`` + ``node_catalog``).

    **Ordering (for positional phrasing) uses only non–sticky-note nodes:**
    ``names_left_to_right``, ``names_top_to_bottom``,
    ``order_index_by_name_left_to_right_0based``, ``order_index_by_name_top_to_bottom_0based``,
    ``node_canvas_excluding_sticky_notes``. Sticky note display names are listed under
    ``sticky_note_names`` and must be ignored when counting \"nth from left\" etc.

    ``connection_edges`` / ``node_neighbors`` include the full graph; ``_legacy_all_nodes_*``
    including sticky is for debugging only.
    """
    edges = connection_edges_list(wf)
    pred, succ = _pred_succ_from_edges(edges)
    all_names: Set[str] = set()
    for e in edges:
        all_names.add(str(e["from"]))
        all_names.add(str(e["to"]))

    node_canvas: List[JSONDict] = []
    pos_by_name: Dict[str, tuple[float, float]] = {}
    sticky_names: List[str] = []
    for n in wf.get("nodes") or []:
        if not isinstance(n, dict) or not n.get("name"):
            continue
        name = str(n["name"])
        if is_sticky_note_node(n):
            sticky_names.append(name)
        all_names.add(name)
        p = n.get("position")
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            try:
                x, y = float(p[0]), float(p[1])
            except (TypeError, ValueError):
                continue
            pos_by_name[name] = (x, y)
            node_canvas.append({"name": name, "x": x, "y": y})

    def _by_x(t: tuple[str, float, float]) -> float:
        return t[1]

    def _by_y(t: tuple[str, float, float]) -> float:
        return t[2]

    with_xy = [(n, pos_by_name[n][0], pos_by_name[n][1]) for n in pos_by_name]
    ltr = [t[0] for t in sorted(with_xy, key=_by_x)]
    ttb = [t[0] for t in sorted(with_xy, key=_by_y)]

    # Position ordering **excluding** sticky notes (n8n annotations are not "workflow" nodes for counting).
    pos_by_name_ns: Dict[str, tuple[float, float]] = {}
    node_canvas_no_sticky: List[JSONDict] = []
    for n in wf.get("nodes") or []:
        if not isinstance(n, dict) or not n.get("name") or is_sticky_note_node(n):
            continue
        name = str(n["name"])
        p = n.get("position")
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            continue
        pos_by_name_ns[name] = (x, y)
        node_canvas_no_sticky.append({"name": name, "x": x, "y": y})

    with_ns = [(n, pos_by_name_ns[n][0], pos_by_name_ns[n][1]) for n in pos_by_name_ns]
    ltr_ns = [t[0] for t in sorted(with_ns, key=_by_x)]
    ttb_ns = [t[0] for t in sorted(with_ns, key=_by_y)]

    order_index_ltr: Dict[str, int] = {nm: i for i, nm in enumerate(ltr_ns)}
    order_index_ttb: Dict[str, int] = {nm: i for i, nm in enumerate(ttb_ns)}

    node_neighbors: Dict[str, Any] = {}
    for n in sorted(all_names):
        node_neighbors[n] = {
            "predecessors": sorted(pred.get(n, set())),
            "successors": sorted(succ.get(n, set())),
        }

    return {
        "connection_edges": edges,
        "node_canvas": node_canvas,
        "node_canvas_excluding_sticky_notes": node_canvas_no_sticky,
        "names_left_to_right": ltr_ns,
        "names_top_to_bottom": ttb_ns,
        "order_index_by_name_left_to_right_0based": order_index_ltr,
        "order_index_by_name_top_to_bottom_0based": order_index_ttb,
        "sticky_note_names": sorted(set(sticky_names)),
        "node_neighbors": node_neighbors,
        "_legacy_all_nodes_left_to_right_including_sticky": ltr,
        "_legacy_all_nodes_top_to_bottom_including_sticky": ttb,
    }
