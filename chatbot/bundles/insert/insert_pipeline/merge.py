from __future__ import annotations

import copy
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple

JSONDict = Dict[str, Any]

# (left, right, output_group_index or None). None => retarget A->B in every main group (legacy).
SpliceEndpoints = Tuple[str, str, Optional[int]]


def _find_node(wf: JSONDict, name: str) -> Optional[JSONDict]:
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        return None
    for n in nodes:
        if isinstance(n, dict) and n.get("name") == name:
            return n
    return None


def _mid_position(left: Optional[JSONDict], right: Optional[JSONDict]) -> List[int]:
    def pos(n: Optional[JSONDict]) -> Optional[Tuple[int, int]]:
        if not n or not isinstance(n.get("position"), list) or len(n["position"]) < 2:
            return None
        try:
            return int(n["position"][0]), int(n["position"][1])
        except Exception:
            return None

    pl, pr = pos(left), pos(right)
    if pl and pr:
        return [int((pl[0] + pr[0]) / 2), int((pl[1] + pr[1]) / 2)]
    if pl:
        return [pl[0] + 200, pl[1]]
    if pr:
        return [pr[0] - 200, pr[1]]
    return [0, 0]


def _outgoing_targets(wf: JSONDict, source: str) -> List[str]:
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


def _incoming_sources(wf: JSONDict, target: str) -> List[str]:
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


def _main_block(wf: JSONDict, source: str) -> Optional[List]:
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        return None
    block = conns.get(source)
    if not isinstance(block, dict):
        return None
    main = block.get("main")
    return main if isinstance(main, list) else None


def _output_indices_with_edge_to(wf: JSONDict, src: str, dst: str) -> List[int]:
    """main output group indices on ``src`` that contain a link to ``dst``."""
    main = _main_block(wf, src)
    if not main:
        return []
    idxs: List[int] = []
    for i, group in enumerate(main):
        if not isinstance(group, list):
            continue
        for link in group:
            if isinstance(link, dict) and str(link.get("node")) == dst:
                idxs.append(i)
                break
    return idxs


def _has_main_edge(wf: JSONDict, src: str, dst: str) -> bool:
    return dst in _outgoing_targets(wf, src)


def _has_main_edge_on_output(wf: JSONDict, src: str, dst: str, out_idx: int) -> bool:
    main = _main_block(wf, src)
    if not main or out_idx < 0 or out_idx >= len(main):
        return False
    group = main[out_idx]
    if not isinstance(group, list):
        return False
    for link in group:
        if isinstance(link, dict) and str(link.get("node")) == dst:
            return True
    return False


def _retarget_outgoing(wf: JSONDict, source: str, old_target: str, new_target: str) -> bool:
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        return False
    block = conns.get(source)
    if not isinstance(block, dict):
        return False
    main = block.get("main")
    if not isinstance(main, list):
        return False
    changed = False
    for group in main:
        if not isinstance(group, list):
            continue
        for link in group:
            if isinstance(link, dict) and str(link.get("node")) == old_target:
                link["node"] = new_target
                if "type" not in link:
                    link["type"] = "main"
                if "index" not in link:
                    link["index"] = 0
                changed = True
    return changed


def _retarget_outgoing_on_output(
    wf: JSONDict, source: str, old_target: str, new_target: str, output_idx: int
) -> bool:
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        return False
    block = conns.get(source)
    if not isinstance(block, dict):
        return False
    main = block.get("main")
    if not isinstance(main, list) or output_idx < 0 or output_idx >= len(main):
        return False
    group = main[output_idx]
    if not isinstance(group, list):
        return False
    changed = False
    for link in group:
        if isinstance(link, dict) and str(link.get("node")) == old_target:
            link["node"] = new_target
            if "type" not in link:
                link["type"] = "main"
            if "index" not in link:
                link["index"] = 0
            changed = True
    return changed


def _ensure_main_output(wf: JSONDict, node_name: str, target: str) -> None:
    conns = wf.setdefault("connections", {})
    if node_name not in conns:
        conns[node_name] = {"main": [[]]}
    block = conns[node_name]
    if not isinstance(block, dict):
        block = {"main": [[]]}
        conns[node_name] = block
    main = block.setdefault("main", [[]])
    if not main or not isinstance(main[0], list):
        main.clear()
        main.append([])
    main[0].append({"node": target, "type": "main", "index": 0})


def _append_outgoing_on_output(wf: JSONDict, source: str, new_target: str, output_idx: int) -> bool:
    """Append ``source -> new_target`` link to main[output_idx] (parallel branch)."""
    conns = wf.setdefault("connections", {})
    block = conns.setdefault(source, {})
    if not isinstance(block, dict):
        block = {"main": [[]]}
        conns[source] = block
    main = block.setdefault("main", [])
    if not isinstance(main, list):
        main = []
        block["main"] = main
    while len(main) <= output_idx:
        main.append([])
    grp = main[output_idx]
    if not isinstance(grp, list):
        grp = []
        main[output_idx] = grp
    grp.append({"node": new_target, "type": "main", "index": 0})
    return True


def _finalize_node_shell(
    *,
    name: str,
    node_type: str,
    parameters: JSONDict,
    position: List[int],
    type_version: Optional[float] = None,
) -> JSONDict:
    tv = type_version if type_version is not None else 1
    node: JSONDict = {
        "id": str(uuid.uuid4()),
        "name": name,
        "type": node_type,
        "typeVersion": tv,
        "position": position,
        "parameters": parameters,
    }
    if "webhook" in node_type.lower():
        path = parameters.get("path")
        wid = parameters.get("webhookId") if isinstance(parameters.get("webhookId"), str) else None
        if not wid:
            wid = path if isinstance(path, str) and path else str(uuid.uuid4())
            node["webhookId"] = wid
            if not isinstance(path, str) or not path:
                node["parameters"] = dict(parameters)
                node["parameters"]["path"] = wid
    return node


_SUPPLEMENTARY_KINDS = frozenset(
    {"supplementary", "tool_for_agent", "langchain_tool", "langchain_attach"}
)


def resolve_supplementary_attachment(wf: JSONDict, loc: JSONDict) -> Optional[Tuple[str, str]]:
    """
    LangChain / agent subgraph wires (non-``main``), e.g. tool → agent via ``ai_tool``.

    Returns ``(connection_channel, target_node_name)`` where the **new** node will emit
    ``connections[new_node][channel] = [[{node: target, type: channel, index: 0}]]``,
    matching common n8n exports.
    """
    kind = str(loc.get("kind") or "").lower()
    tgt_raw = loc.get("target") or loc.get("agent") or loc.get("attach_to")
    if not isinstance(tgt_raw, str) or not tgt_raw.strip():
        return None
    target = tgt_raw.strip()
    if not _find_node(wf, target):
        return None

    ch_raw = loc.get("connection_channel")
    if kind in _SUPPLEMENTARY_KINDS:
        if isinstance(ch_raw, str) and ch_raw.strip():
            channel = ch_raw.strip()
        else:
            channel = "ai_tool"
        return channel, target

    return None


def _ensure_supplementary_outbound(
    wf: JSONDict, source_node: str, channel: str, target_node: str
) -> None:
    conns = wf.setdefault("connections", {})
    block = conns.setdefault(source_node, {})
    if not isinstance(block, dict):
        block = {}
        conns[source_node] = block
    # n8n shape: channel -> [ [ {node, type, index}, ... ], ... ]
    if channel not in block:
        block[channel] = [[]]
    channel_groups = block[channel]
    if not isinstance(channel_groups, list):
        channel_groups = []
        block[channel] = channel_groups
    if not channel_groups or not isinstance(channel_groups[0], list):
        channel_groups.clear()
        channel_groups.append([])
    grp0 = channel_groups[0]
    link = {"node": target_node, "type": channel, "index": 0}
    if not any(
        isinstance(x, dict) and str(x.get("node")) == target_node and x.get("type") == channel for x in grp0
    ):
        grp0.append(link)


def _coerce_int(v: Any, default: Optional[int] = None) -> Optional[int]:
    if v is None:
        return default
    if isinstance(v, bool):
        return default
    try:
        return int(v)
    except Exception:
        return default


def resolve_splice_endpoints(wf: JSONDict, loc: JSONDict) -> Optional[SpliceEndpoints]:
    """
    Returns ``(left, right, output_idx)`` for **inline** splice (break edge left→right).
    ``output_idx`` is the ``main`` branch index on ``left`` where the edge lives.
    ``None`` means change every main group that has left→right (legacy).
    """
    kind = str(loc.get("kind") or "")
    splice_style = str(loc.get("splice_style") or "inline").lower()
    if kind.lower() in _SUPPLEMENTARY_KINDS:
        return None
    if splice_style == "new_branch" or kind.lower() == "branch":
        return None

    explicit_out = _coerce_int(loc.get("from_output"))

    if kind == "between":
        pair = loc.get("between")
        if not (isinstance(pair, list) and len(pair) == 2):
            return None
        a, b = str(pair[0]), str(pair[1])
        if not _find_node(wf, a) or not _find_node(wf, b):
            return None
        if explicit_out is not None:
            if _has_main_edge_on_output(wf, a, b, explicit_out):
                return a, b, explicit_out
            return None
        idxs = _output_indices_with_edge_to(wf, a, b)
        if len(idxs) == 1:
            return a, b, idxs[0]
        if len(idxs) > 1:
            return a, b, None
        if _has_main_edge(wf, a, b):
            return a, b, None
        return None

    if kind == "after":
        a = loc.get("after")
        if not isinstance(a, str):
            return None
        a = a.strip()
        to_ex = loc.get("to_existing")
        if isinstance(to_ex, str) and to_ex.strip():
            dst = to_ex.strip()
            if not _find_node(wf, a) or not _find_node(wf, dst):
                return None
            idxs = _output_indices_with_edge_to(wf, a, dst)
            if explicit_out is not None:
                if explicit_out in idxs and _has_main_edge_on_output(wf, a, dst, explicit_out):
                    return a, dst, explicit_out
                return None
            if len(idxs) == 1:
                return a, dst, idxs[0]
            if len(idxs) > 1:
                return None
            return None
        tgts = _outgoing_targets(wf, a)
        if len(tgts) == 1:
            dst = tgts[0]
            idxs = _output_indices_with_edge_to(wf, a, dst)
            out_i = idxs[0] if len(idxs) == 1 else None
            return a, dst, out_i
        return None

    if kind == "before":
        b = loc.get("before")
        if not isinstance(b, str):
            return None
        b = b.strip()
        from_src = loc.get("from_source")
        if isinstance(from_src, str) and from_src.strip():
            a = from_src.strip()
            if not _find_node(wf, a) or not _find_node(wf, b):
                return None
            idxs = _output_indices_with_edge_to(wf, a, b)
            if explicit_out is not None:
                if explicit_out in idxs and _has_main_edge_on_output(wf, a, b, explicit_out):
                    return a, b, explicit_out
                return None
            if len(idxs) == 1:
                return a, b, idxs[0]
            if len(idxs) > 1:
                return None
            return None
        srcs = _incoming_sources(wf, b)
        if len(srcs) == 1:
            a = srcs[0]
            idxs = _output_indices_with_edge_to(wf, a, b)
            out_i = idxs[0] if len(idxs) == 1 else None
            return a, b, out_i
        return None

    return None


def _parallel_successors_from_left_output(
    wf: JSONDict, left: str, right: str, out_idx: Optional[int]
) -> Set[str]:
    """
    On **template** ``wf``, the set of node names that share ``left``'s ``main[out_idx]`` group
    with a link to ``right`` (parallel fan-out from the same tab). Used to sanitize
    ``main_out_targets``. When ``out_idx`` is None, union groups that contain an edge to ``right``.
    """
    allowed: Set[str] = set()
    if _find_node(wf, right):
        allowed.add(right)
    main = _main_block(wf, left)
    if not main:
        return allowed
    if out_idx is not None:
        if 0 <= out_idx < len(main):
            grp = main[out_idx]
            if isinstance(grp, list):
                for link in grp:
                    if isinstance(link, dict) and link.get("node"):
                        allowed.add(str(link["node"]))
        return allowed
    for grp in main:
        if not isinstance(grp, list):
            continue
        if not any(isinstance(link, dict) and str(link.get("node")) == right for link in grp):
            continue
        for link in grp:
            if isinstance(link, dict) and link.get("node"):
                allowed.add(str(link["node"]))
    return allowed


def _main_in_source_names_from_loc(loc: JSONDict) -> List[str]:
    """Optional Phase-0: extra **main** parents of NEW (beyond the primary splice ``left``)."""
    for key in ("main_in_sources", "main_incoming_sources", "main_incoming"):
        v = loc.get(key)
        if isinstance(v, list) and v:
            return [str(x).strip() for x in v if x is not None and str(x).strip()]
    return []


def _main_out_target_names_from_loc(loc: JSONDict) -> List[str]:
    """Optional Phase-0 list: every **main** child the NEW node should connect to (parallel OK)."""
    for key in ("main_out_targets", "main_follow_targets", "main_outgoing_targets"):
        v = loc.get(key)
        if isinstance(v, list) and v:
            out: List[str] = []
            for x in v:
                if x is None:
                    continue
                t = str(x).strip()
                if t:
                    out.append(t)
            if out:
                return out
    ct = loc.get("connect_to")
    if isinstance(ct, list) and ct:
        return [str(x).strip() for x in ct if x and str(x).strip()]
    return []


def _dedupe_preserve_order(names: List[str]) -> List[str]:
    seen: set[str] = set()
    out: List[str] = []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _validated_targets_in_workflow(wf: JSONDict, names: List[str]) -> List[str]:
    out: List[str] = []
    for n in names:
        if _find_node(wf, n) and n not in out:
            out.append(n)
    return out


def _inline_new_node_main_targets(
    wf: JSONDict, loc: JSONDict, allowed_successors: Set[str]
) -> List[str]:
    """
    Build NEW→* on ``main[0]`` after inline splice.

    ``allowed_successors`` must be the set of nodes that shared ``left``'s output group with
    ``Right`` **on the template before retargeting** (caller should snapshot before mutating).
    """
    extra = _main_out_target_names_from_loc(loc)
    merged: List[str] = []
    seen: set[str] = set()
    for t in _dedupe_preserve_order(extra):
        if t in allowed_successors and t not in seen:
            merged.append(t)
            seen.add(t)
    if not merged:
        merged = sorted(allowed_successors) if allowed_successors else []
    else:
        for t in sorted(allowed_successors):
            if t not in seen:
                merged.append(t)
                seen.add(t)
    return _validated_targets_in_workflow(wf, merged)


def _new_branch_main_follow_filtered(
    wf: JSONDict,
    loc: JSONDict,
    anchor: str,
    out_idx: int,
    downstream: Optional[str],
    *,
    skip_targets: Optional[Set[str]] = None,
) -> List[str]:
    """Sanitize ``connect_to`` / ``main_out_targets`` for ``new_branch`` against anchor's output tab."""
    skip = skip_targets or set()
    follow: List[str] = []
    if downstream:
        d = downstream.strip()
        if d and d not in skip:
            follow.append(d)
    for t in _main_out_target_names_from_loc(loc):
        t = t.strip()
        if t and t not in follow and t not in skip:
            follow.append(t)
    seed = downstream
    if not seed and follow:
        seed = follow[0]
    if not seed:
        return _validated_targets_in_workflow(wf, _dedupe_preserve_order(follow))
    allowed = _parallel_successors_from_left_output(wf, anchor, seed, int(out_idx))
    allowed -= skip
    if not allowed:
        return _validated_targets_in_workflow(wf, _dedupe_preserve_order(follow))
    out: List[str] = []
    seen: set[str] = set()
    for t in _dedupe_preserve_order(follow):
        if t in allowed and t not in seen:
            out.append(t)
            seen.add(t)
    if not out:
        out = sorted(allowed)
    else:
        for t in sorted(allowed):
            if t not in seen:
                out.append(t)
                seen.add(t)
    return _validated_targets_in_workflow(wf, out)


def resolve_new_branch_spec(wf: JSONDict, loc: JSONDict) -> Optional[Tuple[str, int, Optional[str]]]:
    """
    For ``splice_style: new_branch`` / ``kind: branch``: anchor node, main output index, optional downstream name.
    """
    kind_l = str(loc.get("kind") or "").lower()
    if kind_l in _SUPPLEMENTARY_KINDS:
        return None
    if str(loc.get("splice_style") or "").lower() != "new_branch" and kind_l != "branch":
        return None
    anchor = loc.get("anchor") or loc.get("after")
    if not isinstance(anchor, str) or not anchor.strip():
        return None
    anchor = anchor.strip()
    if not _find_node(wf, anchor):
        return None
    out_idx = _coerce_int(loc.get("from_output"), 0)
    if out_idx is None or out_idx < 0:
        return None
    # ``main`` may be missing; ``_append_outgoing_on_output`` will create/extend groups.
    ct = loc.get("connect_to")
    downstream = ct.strip() if isinstance(ct, str) and ct.strip() else None
    if downstream and not _find_node(wf, downstream):
        return None
    return anchor, out_idx, downstream


def apply_insert_splice(
    template: JSONDict,
    *,
    new_node_name: str,
    node_type: str,
    parameters: JSONDict,
    location: JSONDict,
    type_version: Optional[float] = None,
) -> JSONDict:
    """
    Deep-copy ``template``, append a new node, and splice it on ``main``.

    - **inline** (default): break edge left→right into left→NEW→right (``splice_style`` omit or
      ``inline``).
    - **new_branch**: append ``anchor -> NEW`` on ``main[from_output]``; if ``connect_to`` set,
      add ``NEW -> connect_to``.

    Fails soft: if endpoints cannot be resolved, only appends the node without connection changes.
    """
    wf = copy.deepcopy(template)
    nodes = wf.setdefault("nodes", [])
    if not isinstance(nodes, list):
        wf["nodes"] = []
        nodes = wf["nodes"]

    supplementary = resolve_supplementary_attachment(wf, location)
    if supplementary is not None:
        channel, consumer = supplementary
        peer = _find_node(wf, consumer)
        pos = _mid_position(None, peer)
        if peer is not None:
            pp = peer.get("position")
            if isinstance(pp, list) and len(pp) >= 2:
                try:
                    pos = [int(pp[0]) + 180, int(pp[1]) + 140]
                except Exception:
                    pass
        new_node = _finalize_node_shell(
            name=new_node_name,
            node_type=node_type,
            parameters=parameters,
            position=pos,
            type_version=type_version,
        )
        nodes.append(new_node)
        _ensure_supplementary_outbound(wf, new_node_name, channel, consumer)
        return wf

    branch_spec = resolve_new_branch_spec(wf, location)

    anchor_for_pos: Optional[JSONDict] = None
    peer_for_pos: Optional[JSONDict] = None

    if branch_spec is not None:
        anchor_name, out_idx, downstream = branch_spec
        layout_hint = downstream
        if not layout_hint:
            mt0 = _main_out_target_names_from_loc(location)
            if mt0:
                layout_hint = mt0[0]
        anchor_for_pos = _find_node(wf, anchor_name)
        peer_for_pos = _find_node(wf, layout_hint) if layout_hint else None
        pos = _mid_position(anchor_for_pos, peer_for_pos)
        if peer_for_pos is None and anchor_for_pos is not None:
            ap = anchor_for_pos.get("position")
            if isinstance(ap, list) and len(ap) >= 2:
                try:
                    pos = [int(ap[0]) + 240, int(ap[1])]
                except Exception:
                    pos = _mid_position(anchor_for_pos, None)

        new_node = _finalize_node_shell(
            name=new_node_name,
            node_type=node_type,
            parameters=parameters,
            position=pos,
            type_version=type_version,
        )
        nodes.append(new_node)
        _append_outgoing_on_output(wf, anchor_name, new_node_name, out_idx)
        follow = _new_branch_main_follow_filtered(
            wf,
            location,
            anchor_name,
            int(out_idx),
            downstream,
            skip_targets={new_node_name},
        )
        for t in follow:
            _ensure_main_output(wf, new_node_name, t)
        return wf

    ends = resolve_splice_endpoints(wf, location)
    left_n = _find_node(wf, ends[0]) if ends else None
    right_n = _find_node(wf, ends[1]) if ends else None
    pos = _mid_position(left_n, right_n)

    new_node = _finalize_node_shell(
        name=new_node_name,
        node_type=node_type,
        parameters=parameters,
        position=pos,
        type_version=type_version,
    )
    nodes.append(new_node)

    if not ends:
        return wf
    left, right, out_idx = ends[0], ends[1], ends[2]
    allowed_successors = _parallel_successors_from_left_output(wf, left, right, out_idx)
    for s in _main_in_source_names_from_loc(location):
        if not s or s == left or not _find_node(wf, s):
            continue
        for j in _output_indices_with_edge_to(wf, s, right):
            _retarget_outgoing_on_output(wf, s, right, new_node_name, j)
    if out_idx is not None:
        ok = _retarget_outgoing_on_output(wf, left, right, new_node_name, out_idx)
    else:
        ok = _retarget_outgoing(wf, left, right, new_node_name)
    if ok:
        for t in _inline_new_node_main_targets(wf, location, allowed_successors):
            _ensure_main_output(wf, new_node_name, t)
    return wf


def splice_location_resolvable(wf: JSONDict, loc: JSONDict) -> bool:
    """True if ``apply_insert_splice`` will alter connections (not append-only orphan)."""
    if resolve_supplementary_attachment(wf, loc) is not None:
        return True
    if str(loc.get("splice_style") or "").lower() == "new_branch" or str(loc.get("kind") or "").lower() == "branch":
        return resolve_new_branch_spec(wf, loc) is not None
    return resolve_splice_endpoints(wf, loc) is not None
