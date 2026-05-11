"""
Deletion agent: LLM resolves which node(s) to remove; program removes nodes + edges.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from modify_pipeline.pipeline import (
    OpenAiUsageLog,
    TwoPhaseConfig,
    UserConfirmFn,
    TextCompleteFn,
    _client,
    _parse_resolved_node_names,
    aggregate_openai_usage,
    build_node_catalog,
    llm_resolve_node,
)

from .apply_delete import names_exist_in_workflow, remove_nodes_from_workflow
from .graph_hints import build_deletion_resolve_extras
from .interaction import apply_deletion_interaction

JSONDict = Dict[str, Any]


DELETE_RESOLVE_SYSTEM = """You map natural-language deletion instructions to n8n workflow node(s) to REMOVE.
The workflow is described as a list of nodes with: name, type, typeVersion, parameter_keys.

Structured fields (when present) — use them **exactly** as defined:
- ``connection_edges``: directed edges {from, to} — for *graph* *before* / *after* (predecessor/successor along edges), and branches.
- ``names_left_to_right``: **only non–sticky-note nodes**, sorted by **increasing x** (canvas). Index 0 = leftmost, last = rightmost. Sticky notes are **excluded**; do not count them for \"nth from the left/right\".
- ``names_top_to_bottom``: **only non–sticky-note nodes**, sorted by **increasing y** (n8n: smaller y = higher on the canvas). Sticky notes **excluded**. Index 0 = top, last = bottom.
- ``order_index_by_name_left_to_right_0based`` / ``order_index_by_name_top_to_bottom_0based``: 0-based position of each name in the two orders above. Use for \"5th from the left\" = **1-based** index 5 ⇒ find name whose 0-based index is 4 in ``names_left_to_right``.
- ``sticky_note_names``: names to **ignore** for positional counting; they are UI annotations, not the workflow to delete in \"nth node\" phrasing.
- ``node_canvas_excluding_sticky_notes``: {name, x, y} for ordering (same set as the two orders above).
- ``node_neighbors``: predecessors / successors (from all nodes, including for targeting \"before/after X\").

**Positional phrases:** \"from the right\" = from the end of ``names_left_to_right`` (last index = rightmost). \"From the left\" = from index 0. Be consistent with **0-based** indices in the payload vs **1-based** user language (e.g. \"2nd from left\" = order index 1).

Reply with a single JSON object (no markdown):
{
  "resolution": "found" | "not_found" | "ambiguous",
  "node_name": string | null,
  "node_names": [ string, ... ] | null,
  "candidates": [ { "name": string, "type": string, "reason": string } ],
  "rationale": string
}

Rules:
- "found": the user clearly wants to delete one or more specific nodes; set node_names to every node that must be removed
  (or a single name in node_name). For positional hints (e.g. "second from the right"), resolve to the actual node name(s) from the catalog.
- "not_found": no node in the catalog plausibly matches the instruction.
- "ambiguous": you cannot map the instruction to a specific set of nodes; set candidates to up to 5 entries; null node_name(s).
- All names must appear in the provided catalog. No duplicates in node_names."""


def run_deletion(
    workflow: JSONDict,
    user_instruction: str,
    *,
    config: TwoPhaseConfig,
    confirmed_node_names: Optional[List[str]] = None,
    user_confirm: Optional[UserConfirmFn] = None,
    text_complete: Optional[TextCompleteFn] = None,
    expected_removal_names: Optional[Set[str]] = None,
    simulate_deletion_interaction: bool = True,
) -> JSONDict:
    """
    1) LLM: resolve which node(s) to delete (or not_found / ambiguous).
    2) Optional ``user_confirm`` when resolution is unclear.
    3) User-action simulation (see ``delete_pipeline.interaction``): if the instruction names a
       technical type with multiple instances, type-picker; else confirm-to-delete. Eval passes
       ``expected_removal_names`` (oracle) to pick the right instance; ``simulate_deletion_interaction``
       also assumes \"Yes\" to confirm.
    4) Program: remove those nodes from ``nodes`` and strip all connection edges involving them.
    """
    api_usage_log: OpenAiUsageLog = []
    client: Any
    if text_complete is None:
        client = _client(config)
        usage_log_ref: Optional[OpenAiUsageLog] = api_usage_log
    else:
        client = None
        usage_log_ref = None

    resolved_names: List[str] = []
    if confirmed_node_names is not None:
        if not confirmed_node_names:
            return {
                "ok": False,
                "step": "resolve",
                "message": "confirmed_node_names is empty; pass None to use the resolver.",
                "api_usage": [],
                "api_usage_totals": aggregate_openai_usage([]),
            }
        for x in confirmed_node_names:
            if isinstance(x, str) and x and x not in resolved_names:
                resolved_names.append(x)

    resolution: JSONDict = {}

    if not resolved_names:
        catalog = build_node_catalog(workflow)
        resolution = llm_resolve_node(
            client=client,
            model=config.model,
            user_instruction=user_instruction,
            catalog=catalog,
            temperature=config.temperature,
            max_tokens=config.max_tokens_resolve,
            text_complete=text_complete,
            usage_log=usage_log_ref,
            resolve_system=DELETE_RESOLVE_SYSTEM,
            extra_user_fields=build_deletion_resolve_extras(workflow),
        )
        status = str(resolution.get("resolution") or "")
        if status == "found":
            resolved_names = _parse_resolved_node_names(resolution)
        if not resolved_names and user_confirm is not None:
            picked = user_confirm(resolution)
            if isinstance(picked, list) and picked:
                resolved_names = [x for x in picked if isinstance(x, str) and x]
                seen2: set = set()
                res: List[str] = []
                for x in resolved_names:
                    if x not in seen2:
                        seen2.add(x)
                        res.append(x)
                resolved_names = res
        if not resolved_names and status == "found":
            if isinstance(resolution.get("node_name"), str) and resolution["node_name"]:
                resolved_names = [resolution["node_name"]]

    if not resolved_names:
        return {
            "ok": False,
            "step": "resolve",
            "resolution": resolution,
            "message": "Node(s) not resolved; user confirmation or clearer instruction required.",
            "api_usage": list(api_usage_log),
            "api_usage_totals": aggregate_openai_usage(api_usage_log),
        }

    used_confirm_path = confirmed_node_names is not None
    if used_confirm_path:
        inter_report = {
            "skipped_llm_resolve": True,
            "would_ask_type_picker": False,
            "would_show_confirm_delete": True,
            "simulated_user_confirmed": simulate_deletion_interaction,
        }
        names_after_interaction = list(resolved_names)
    else:
        names_after_interaction, inter_report = apply_deletion_interaction(
            workflow,
            user_instruction,
            resolved_names,
            expected_removal_names=expected_removal_names,
            simulate_user_confirm=simulate_deletion_interaction,
        )
    if inter_report.get("type_disambiguation_unresolved") and not expected_removal_names:
        return {
            "ok": False,
            "step": "type_disambiguation",
            "resolution": resolution,
            "llm_suggested": resolved_names,
            "candidates": (inter_report.get("type_picker") or {}).get("candidate_names"),
            "deletion_interaction": inter_report,
            "message": "Multiple nodes match the technical type; user must pick one.",
            "api_usage": list(api_usage_log),
            "api_usage_totals": aggregate_openai_usage(api_usage_log),
        }
    resolved_names = names_after_interaction
    if not resolved_names:
        return {
            "ok": False,
            "step": "interaction",
            "resolution": resolution,
            "deletion_interaction": inter_report,
            "message": "No target node(s) after disambiguation/confirmation.",
            "api_usage": list(api_usage_log),
            "api_usage_totals": aggregate_openai_usage(api_usage_log),
        }

    missing = names_exist_in_workflow(workflow, resolved_names)
    if missing:
        return {
            "ok": False,
            "step": "validate",
            "resolution": resolution,
            "resolved_node_names": resolved_names,
            "deletion_interaction": inter_report,
            "message": f"Resolved name(s) not in workflow.nodes: {missing}",
            "api_usage": list(api_usage_log),
            "api_usage_totals": aggregate_openai_usage(api_usage_log),
        }

    try:
        modified = remove_nodes_from_workflow(workflow, set(resolved_names))
    except Exception as e:
        return {
            "ok": False,
            "step": "delete",
            "resolution": resolution,
            "resolved_node_names": resolved_names,
            "deletion_interaction": inter_report,
            "message": str(e),
            "api_usage": list(api_usage_log),
            "api_usage_totals": aggregate_openai_usage(api_usage_log),
        }

    out: JSONDict = {
        "ok": True,
        "step": "done",
        "resolution": resolution,
        "resolved_node_names": resolved_names,
        "modified_workflow": modified,
        "api_usage": list(api_usage_log),
        "api_usage_totals": aggregate_openai_usage(api_usage_log),
        "deletion_interaction": inter_report,
    }
    if len(resolved_names) == 1:
        out["resolved_node_name"] = resolved_names[0]
    return out
