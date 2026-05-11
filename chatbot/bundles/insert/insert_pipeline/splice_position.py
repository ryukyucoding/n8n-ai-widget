"""
Phase-0 LLM helper: infer splice ``location`` from instruction + template graph sketch.

Output is consumed by ``merge.apply_insert_splice`` / ``merge.splice_location_resolvable``.

**LangChain / agent subgraph** (non-``main`` wires, e.g. tool → agent):

- ``{"kind": "tool_for_agent", "agent": "My Agent"}`` — default channel ``ai_tool``.
- ``{"kind": "supplementary", "connection_channel": "ai_memory", "target": "My Agent"}``
  (channels include ``ai_tool``, ``ai_memory``, ``ai_embedding``, ``ai_reranker``, …).

**Inline splice** (break one main edge ``Left → Right`` into ``Left → NEW → Right``):

- ``{"kind": "between", "between": ["Left", "Right"], "from_output": 0}``
- ``{"kind": "after", "after": "A", "to_existing": "B", "from_output": 1}``
- ``{"kind": "before", "before": "B", "from_source": "A", "from_output": 0}``

Optional **multi-main-in** (Phase 0): add ``main_in_sources`` — see ``default_phase0_splice_system_prompt``.

**New branch** (add a parallel main link from an existing output group):

- ``{"kind": "after", "after": "A", "splice_style": "new_branch", "from_output": 1,
     "connect_to": "Merge"}``  — ``connect_to`` optional.
- Or ``{"kind": "branch", "anchor": "A", "from_output": 1, "connect_to": "..."}`` (normalized to
  ``splice_style: new_branch``).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from .merge import splice_location_resolvable

JSONDict = Dict[str, Any]

_SUPPLEMENTARY_PARSED_KINDS = frozenset(
    {"supplementary", "tool_for_agent", "langchain_tool", "langchain_attach"}
)

_OPTIONAL_SPLICE_KEYS = (
    "from_output",
    "from_source",
    "to_existing",
    "splice_style",
    "connect_to",
    "anchor",
    "connection_channel",
    "target",
    "agent",
    "attach_to",
)


def _format_template_main_graph_core(wf: JSONDict) -> str:
    """Nodes list + main-edge listings (no branching summary / aux)."""
    lines: List[str] = []
    nodes = wf.get("nodes") if isinstance(wf.get("nodes"), list) else []
    by_name: Dict[str, JSONDict] = {}
    for n in nodes:
        if isinstance(n, dict) and n.get("name"):
            by_name[str(n["name"])] = n
    lines.append("NODES (use these exact display names for anchors):")
    for name in sorted(by_name.keys()):
        n = by_name[name]
        pos = n.get("position")
        pos_s = ""
        if isinstance(pos, list) and len(pos) >= 2:
            try:
                pos_s = f" position=[{int(pos[0])},{int(pos[1])}]"
            except Exception:
                pos_s = f" position={pos!r}"
        lines.append(f"  - {name!r}: type={n.get('type')!r}{pos_s}")

    conns = wf.get("connections")
    if not isinstance(conns, dict):
        lines.append("\nMAIN EDGES (connections[].main, flattened):")
        lines.append("  (no connections)")
        return "\n".join(lines)

    seen = set()
    for src in sorted(conns.keys()):
        block = conns.get(src)
        if not isinstance(block, dict):
            continue
        main = block.get("main")
        if not isinstance(main, list):
            continue
        for group in main:
            if not isinstance(group, list):
                continue
            for link in group:
                if isinstance(link, dict) and link.get("node"):
                    seen.add((src, str(link["node"])))

    lines.append("\nMAIN EDGES (unique pairs, flattened; order not special):")
    if seen:
        for src, dst in sorted(seen):
            lines.append(f"  {src!r} -> {dst!r}")
    else:
        lines.append("  (no main edges found)")

    lines.append("\nMAIN EDGES BY OUTPUT INDEX (use from_output = this [i] for branching):")
    any_branch = False
    for src in sorted(conns.keys()):
        block = conns.get(src)
        if not isinstance(block, dict):
            continue
        main = block.get("main")
        if not isinstance(main, list):
            continue
        for out_i, group in enumerate(main):
            if not isinstance(group, list):
                continue
            for link in group:
                if isinstance(link, dict) and link.get("node"):
                    dst = str(link["node"])
                    lines.append(f"  [{out_i}] {src!r} -> {dst!r}")
                    any_branch = True
    if not any_branch:
        lines.append("  (none)")

    lines.append("\nIN / OUT MAIN DEGREE (number of distinct neighbors on flattened main edges):")
    out_n: Dict[str, set] = {}
    in_n: Dict[str, set] = {}
    for src in sorted(conns.keys()):
        block = conns.get(src)
        if not isinstance(block, dict):
            continue
        main = block.get("main")
        if not isinstance(main, list):
            continue
        for group in main:
            if not isinstance(group, list):
                continue
            for link in group:
                if isinstance(link, dict) and link.get("node"):
                    dst = str(link["node"])
                    out_n.setdefault(src, set()).add(dst)
                    in_n.setdefault(dst, set()).add(src)
    for name in sorted(by_name.keys()):
        ins = len(in_n.get(name, set()))
        outs = len(out_n.get(name, set()))
        if ins != 1 or outs != 1:
            lines.append(f"  {name!r}: in_deg={ins}, out_deg={outs}  (ambiguous for plain before/after)")

    return "\n".join(lines)


def format_auxiliary_edges_for_llm(wf: JSONDict) -> str:
    """
    Non-``main`` connection channels (LangChain agent subgraph: tools, memory, embeddings, …).
    """
    lines: List[str] = [
        "\nLANGCHAIN / AUXILIARY CONNECTIONS (non-main; use for *Tool nodes wired to an Agent):"
    ]
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        lines.append("  (none)")
        return "\n".join(lines)
    any_e = False
    for src in sorted(conns.keys()):
        block = conns[src]
        if not isinstance(block, dict):
            continue
        for channel in sorted(x for x in block.keys() if x != "main"):
            val = block[channel]
            if not isinstance(val, list):
                continue
            for gi, group in enumerate(val):
                if not isinstance(group, list):
                    continue
                for link in group:
                    if isinstance(link, dict) and link.get("node"):
                        dst = str(link["node"])
                        lines.append(f"  {src!r} --[{channel}][{gi}]--> {dst!r}")
                        any_e = True
    if not any_e:
        lines.append("  (none)")
    return "\n".join(lines)


def format_multi_outgoing_main_summary(wf: JSONDict) -> str:
    """Highlight Switch-like nodes: multiple ``main`` output groups with links."""
    lines: List[str] = [
        "\nMAIN BRANCHING (nodes with 2+ non-empty main output tabs — you MUST set from_output / "
        "to_existing to match ONE branch):"
    ]
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        lines.append("  (none)")
        return "\n".join(lines)
    any_m = False
    for src in sorted(conns.keys()):
        block = conns.get(src)
        if not isinstance(block, dict):
            continue
        main = block.get("main")
        if not isinstance(main, list):
            continue
        nonempty: List[Tuple[int, List[str]]] = []
        for out_i, group in enumerate(main):
            if not isinstance(group, list):
                continue
            dsts = [str(link["node"]) for link in group if isinstance(link, dict) and link.get("node")]
            if dsts:
                nonempty.append((out_i, dsts))
        if len(nonempty) > 1:
            parts: List[str] = []
            for out_i, dsts in nonempty:
                for d in dsts:
                    parts.append(f"[{out_i}]→{d!r}")
            lines.append(f"  {src!r}: " + ", ".join(parts))
            any_m = True
    if not any_m:
        lines.append("  (none)")
    return "\n".join(lines)


def format_main_quick_traces_for_llm(wf: JSONDict, *, max_roots: int = 6, max_hops: int = 14) -> str:
    """
    One greedy path from each main ``root`` (no incoming main edge) until the first branch.
    When several roots exist, this hints execution entry without replacing the BY OUTPUT INDEX list.
    """
    nodes = wf.get("nodes") if isinstance(wf.get("nodes"), list) else []
    by_name: Dict[str, JSONDict] = {}
    for n in nodes:
        if isinstance(n, dict) and n.get("name"):
            by_name[str(n["name"])] = n
    conns = wf.get("connections")
    incoming: set[str] = set()
    if isinstance(conns, dict):
        for _src, block in conns.items():
            if not isinstance(block, dict):
                continue
            main = block.get("main")
            if not isinstance(main, list):
                continue
            for group in main:
                if not isinstance(group, list):
                    continue
                for link in group:
                    if isinstance(link, dict) and link.get("node"):
                        incoming.add(str(link["node"]))
    roots = [n for n in sorted(by_name.keys()) if n not in incoming][:max_roots]

    def main_children(node: str) -> List[Tuple[int, str]]:
        out: List[Tuple[int, str]] = []
        if not isinstance(conns, dict):
            return out
        block = conns.get(node)
        if not isinstance(block, dict):
            return out
        main = block.get("main")
        if not isinstance(main, list):
            return out
        for out_i, group in enumerate(main):
            if not isinstance(group, list):
                continue
            for link in group:
                if isinstance(link, dict) and link.get("node"):
                    out.append((out_i, str(link["node"])))
        return out

    lines: List[str] = [
        "\nMAIN QUICK TRACE (follow single-successor hops from roots until a branch; "
        "if instruction names two nodes on MAIN, prefer between/after+before on MAIN; "
        "if inserting a LangChain *Tool for an Agent, use tool_for_agent instead):"
    ]
    if not roots:
        lines.append("  (could not infer roots)")
        return "\n".join(lines)
    for root in roots:
        path: List[str] = [root]
        cur = root
        visited: set[str] = {root}
        hops = 0
        while hops < max_hops:
            ch = main_children(cur)
            if len(ch) != 1:
                if len(ch) > 1:
                    fork = ", ".join(f"[{i}]→{d!r}" for i, d in ch)
                    path.append(f"<branch {fork}>")
                break
            _oi, nxt = ch[0]
            if nxt in visited:
                path.append(f"<cycle {nxt!r}>")
                break
            visited.add(nxt)
            path.append(nxt)
            cur = nxt
            hops += 1
        lines.append("  " + " → ".join(path))
    return "\n".join(lines)


def format_parallel_main_same_group(wf: JSONDict) -> str:
    """
    Same source + same main output index [i] with **multiple** links = parallel main fan-out
    (n8n stores them as several items in the same ``main[i]`` array).
    """
    lines: List[str] = [
        "\nPARALLEL MAIN (same source + same output index [i], multiple destinations in ONE group):"
    ]
    conns = wf.get("connections")
    if not isinstance(conns, dict):
        lines.append("  (none)")
        return "\n".join(lines)
    any_p = False
    for src in sorted(conns.keys()):
        block = conns.get(src)
        if not isinstance(block, dict):
            continue
        main = block.get("main")
        if not isinstance(main, list):
            continue
        for out_i, group in enumerate(main):
            if not isinstance(group, list):
                continue
            dsts = [
                str(link["node"])
                for link in group
                if isinstance(link, dict) and link.get("node")
            ]
            if len(dsts) > 1:
                uniq = []
                seen: set[str] = set()
                for d in dsts:
                    if d not in seen:
                        seen.add(d)
                        uniq.append(d)
                lines.append(f"  [{out_i}] {src!r} -> {uniq!r}  (NEW may need main_out_targets listing ALL of these)")
                any_p = True
    if not any_p:
        lines.append("  (none)")
    return "\n".join(lines)


def format_template_main_graph_for_llm(wf: JSONDict) -> str:
    """
    Full template graph digest for phase-0: main listings, branching summary, quick traces, aux edges.
    """
    core = _format_template_main_graph_core(wf)
    parallel = format_parallel_main_same_group(wf)
    branch = format_multi_outgoing_main_summary(wf)
    trace = format_main_quick_traces_for_llm(wf)
    aux = format_auxiliary_edges_for_llm(wf)
    return core + parallel + branch + trace + aux


def default_phase0_splice_system_prompt() -> str:
    return (
        "You decide WHERE a new n8n node should attach in an EXISTING workflow template.\n"
        "You receive: the insert instruction; NODES; MAIN edges; MAIN BY OUTPUT INDEX [i]; "
        "MAIN BRANCHING (multi-output nodes); MAIN QUICK TRACE; IN/OUT main-degree hints; "
        "and LANGCHAIN/AUXILIARY connections (non-main).\n"
        "The new node is NOT in the graph yet. Use only existing node names from NODES.\n"
        "Return ONLY valid JSON (no markdown fences, no commentary).\n"
        "\n"
        "**C) LangChain / agent supplement** — when inserting a sub-node that wires to an Agent on a "
        "NON-main channel (e.g. Google Calendar Tool, MCP Tool → Agent via ai_tool):\n"
        "  {\"kind\": \"tool_for_agent\", \"agent\": \"AI Agent node name\"}\n"
        "Default connection is ai_tool from the NEW node to that agent. "
        "For memory / embedding / reranker slots use:\n"
        "  {\"kind\": \"supplementary\", \"connection_channel\": \"ai_memory\", \"target\": \"AgentName\"}\n"
        "Valid channel examples: ai_tool, ai_memory, ai_embedding, ai_reranker (match AUXILIARY section).\n"
        "Use (C) when the instruction names a *Tool type or the template already shows ai_tool links to "
        "an Agent — even if the user phrased it as \"between X and Agent\" on the main path.\n"
        "\n"
        "**A) Inline splice on MAIN** — break exactly ONE main edge into Left → NEW → Right:\n"
        "Omit splice_style or set \"splice_style\": \"inline\".\n"
        "  {\"kind\": \"between\", \"between\": [\"Left\", \"Right\"]}\n"
        "    If multiple [i] have Left→Right, you MUST add \"from_output\": <int> matching the graph.\n"
        "**Multi main parents:** When ``Right`` has **several** incoming main edges (PARALLEL MAIN "
        "into one node) and you splice on **one** of them, list every **other** source that "
        "currently reaches ``Right`` on main so they all retarget to NEW:\n"
        "  \"main_in_sources\": [\"OtherSource1\", \"OtherSource2\", ...]  (omit the primary "
        "``Left`` / ``from_source``; that edge is implied).\n"
        "Aliases: \"main_incoming_sources\", \"main_incoming\" (same array).\n"
        "**Multi main children (IMPORTANT):** After the splice, the NEW node may need to fan out on "
        "**main** to **several** nodes (IF / Text Classifier / parallel rows in PARALLEL MAIN). "
        "Then add:\n"
        "  \"main_out_targets\": [\"NodeA\", \"NodeB\", ...]  (exact NODES names; **every** main "
        "downstream the NEW node must reach, usually including \"Right\" and any siblings in the same "
        "PARALLEL MAIN line).\n"
        "Aliases accepted: \"main_follow_targets\", \"main_outgoing_targets\" (same array).\n"
        "  {\"kind\": \"after\", \"after\": \"A\", \"to_existing\": \"B\"}\n"
        "    Use when A has multiple outgoing main targets; pick the branch A→B. "
        "If several [i] go to the same B, set \"from_output\".\n"
        "  {\"kind\": \"before\", \"before\": \"B\", \"from_source\": \"A\"}\n"
        "    Use when B has multiple incoming sources; pick the edge A→B. "
        "If several [i] on A reach B, set \"from_output\".\n"
        "  {\"kind\": \"after\", \"after\": \"A\"} / {\"kind\": \"before\", \"before\": \"B\"}\n"
        "    Only when that node has exactly one neighbor on the relevant side (see degree lines).\n"
        "\n"
        "**B) New parallel branch on MAIN** — add another main link from an existing output group (no cut):\n"
        "  {\"kind\": \"after\", \"after\": \"AnchorName\", \"splice_style\": \"new_branch\", "
        "\"from_output\": <int>}\n"
        "Optional: \"connect_to\": \"DownstreamName\" **or** a JSON array of names to add several NEW→* "
        "main links. You may also use \"main_out_targets\" the same way.\n"
        "Or: {\"kind\": \"branch\", \"anchor\": \"AnchorName\", \"from_output\": <int>, "
        "\"connect_to\": \"...\"}\n"
        "\n"
        "Prefer \"between\" on MAIN when the user names two nodes that are directly connected on MAIN.\n"
        "Use MAIN BRANCHING + BY OUTPUT INDEX to disambiguate Switch/IF-style nodes.\n"
        "Copy node names EXACTLY as in NODES (spelling).\n"
    )


def build_phase0_splice_messages(
    *,
    instruction_head: str,
    graph_text: str,
    regex_location_hint: str = "",
    system_prompt: Optional[str] = None,
) -> List[JSONDict]:
    sys = system_prompt or default_phase0_splice_system_prompt()
    user_parts = [
        "USER INSERT INSTRUCTION (template JSON omitted):\n" + instruction_head.strip() + "\n",
        "TEMPLATE GRAPH (main + branching + aux):\n" + graph_text + "\n",
    ]
    if regex_location_hint.strip():
        user_parts.append(
            "Optional hint from naive phrase parsing (may be wrong on branching graphs); "
            "prefer the graph + instruction:\n"
            + regex_location_hint.strip()
            + "\n"
        )
    user = "\n".join(user_parts)
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def _merge_optional_splice_fields(dst: JSONDict, src: JSONDict) -> None:
    for k in _OPTIONAL_SPLICE_KEYS:
        if k not in src:
            continue
        v = src[k]
        if v is None:
            continue
        if k == "from_output":
            try:
                dst[k] = int(v)
            except (TypeError, ValueError):
                pass
            continue
        if k in (
            "from_source",
            "to_existing",
            "connect_to",
            "anchor",
            "splice_style",
            "connection_channel",
            "target",
            "agent",
            "attach_to",
        ):
            if isinstance(v, str) and v.strip():
                dst[k] = v.strip()
            elif k == "splice_style" and isinstance(v, str):
                dst[k] = v.strip().lower()


def _merge_main_in_sources_arrays(dst: JSONDict, src: JSONDict) -> None:
    """Normalize optional multi-incoming main parents into ``main_in_sources``."""
    for key in ("main_in_sources", "main_incoming_sources", "main_incoming"):
        v = src.get(key)
        if not isinstance(v, list) or not v:
            continue
        clean = [str(x).strip() for x in v if x is not None and str(x).strip()]
        if clean:
            dst["main_in_sources"] = clean
            return


def _merge_main_out_target_arrays(dst: JSONDict, src: JSONDict) -> None:
    """Normalize optional multi-out main targets from Phase 0 JSON into ``main_out_targets``."""
    for key in ("main_out_targets", "main_follow_targets", "main_outgoing_targets"):
        v = src.get(key)
        if not isinstance(v, list) or not v:
            continue
        clean = [str(x).strip() for x in v if x is not None and str(x).strip()]
        if clean:
            dst["main_out_targets"] = clean
            return
    ct = src.get("connect_to")
    if isinstance(ct, list) and ct:
        clean = [str(x).strip() for x in ct if x is not None and str(x).strip()]
        if clean:
            dst["main_out_targets"] = clean


def parse_phase0_splice_json(text: str) -> Optional[JSONDict]:
    if not (text or "").strip():
        return None
    raw = text.strip()
    try:
        obj = json.loads(raw)
    except Exception:
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            obj = json.loads(raw[start : end + 1])
        except Exception:
            return None
    if not isinstance(obj, dict):
        return None
    kind = str(obj.get("kind") or "").lower()
    base: Optional[JSONDict] = None

    if kind in _SUPPLEMENTARY_PARSED_KINDS:
        tgt = obj.get("target") or obj.get("agent") or obj.get("attach_to")
        if isinstance(tgt, str) and tgt.strip():
            base = {"kind": kind}
            _merge_optional_splice_fields(base, obj)
            _merge_main_out_target_arrays(base, obj)
            _merge_main_in_sources_arrays(base, obj)
            return base

    if kind == "branch":
        anchor = obj.get("anchor") or obj.get("from") or obj.get("after")
        if isinstance(anchor, str) and anchor.strip():
            base = {
                "kind": "after",
                "after": anchor.strip(),
                "splice_style": "new_branch",
            }
    elif kind == "between":
        pair = obj.get("between")
        if isinstance(pair, list) and len(pair) >= 2:
            a, b = str(pair[0]).strip(), str(pair[1]).strip()
            if a and b:
                base = {"kind": "between", "between": [a, b]}
    elif kind == "after":
        a = obj.get("after")
        if isinstance(a, str) and a.strip():
            base = {"kind": "after", "after": a.strip()}
    elif kind == "before":
        b = obj.get("before")
        if isinstance(b, str) and b.strip():
            base = {"kind": "before", "before": b.strip()}
    if not base:
        return None
    _merge_optional_splice_fields(base, obj)
    if str(base.get("splice_style") or "inline").lower() == "new_branch":
        anch = base.get("anchor")
        if isinstance(anch, str) and anch.strip() and base.get("after") != anch.strip():
            base["after"] = anch.strip()
    _merge_main_out_target_arrays(base, obj)
    _merge_main_in_sources_arrays(base, obj)
    return base


def location_is_resolvable_on_template(template: JSONDict, loc: JSONDict) -> bool:
    """True iff ``apply_insert_splice`` will change connections (not append-only orphan)."""
    return splice_location_resolvable(template, loc)
