"""
Minimal two-phase INSERT runner for the n8n AI widget (standalone insert bundle on PYTHONPATH).
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional

from openai import OpenAI

JSONDict = Dict[str, Any]


def insert_pipeline_debug_enabled() -> bool:
    """``WIDGET_INSERT_DEBUG=1`` or ``N8N_INSERT_DEBUG=1`` → stderr traces from this runner."""
    v = (os.environ.get("WIDGET_INSERT_DEBUG") or os.environ.get("N8N_INSERT_DEBUG") or "").strip().lower()
    return v in ("1", "true", "yes", "all", "debug")


def _ins_trace(title: str, body: str = "") -> None:
    line = "=" * 72
    print(f"\n{line}\n[insert-pipeline] {title}\n{line}", file=sys.stderr, flush=True)
    if body:
        print(body, file=sys.stderr, flush=True)

PLAN_SYSTEM = """You convert a natural-language request to a machine-readable insert header for n8n.
You MUST use only these exact node display names when anchoring: the names are provided in the user message.

Return ONLY JSON:
{
  "inserted_node_name": "<short display name for the NEW node, unique in the workflow>",
  "tail_sentence": "<one sentence matching ONE of: after \"NodeName\" | before \"NodeName\" | between \"NodeA\" and \"NodeB\">",
  "declared_node_type": "<full n8n type e.g. n8n-nodes-base.slack> or null if unknown"
}

Rules:
- Names in quotes MUST exist in the provided name list (copy spelling exactly).
- If the user does not specify position, prefer inserting after the last node in the main data path or after the leftmost trigger.
- LangChain / AI Agent tools: When the user wants a **tool** that plugs into an **AI Agent** node's Tool port
  (sub-workflow, dashed connection, not a normal left-to-right main canvas edge), you MUST set
  ``declared_node_type`` to the integration's **Tool** node type string (catalog names end with ``Tool``),
  e.g. ``n8n-nodes-base.googleSheetsTool`` for Google Sheets-as-tool — NOT ``n8n-nodes-base.googleSheets``.
  The ``tail_sentence`` should anchor to the **agent** display name when they say the tool goes "in/under/for" that agent.
- If unclear which integration, set declared_node_type to null."""


def _complete_messages(client: OpenAI, model: str, messages: List[JSONDict], max_tokens: int = 1024) -> str:
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0,
        max_tokens=max_tokens,
        response_format={"type": "json_object"},
    )
    if not resp.choices or not resp.choices[0].message:
        return ""
    c = resp.choices[0].message.content
    return c if isinstance(c, str) else ""


def _plan_insert_header(
    client: OpenAI,
    model: str,
    workflow: JSONDict,
    instruction: str,
) -> JSONDict:
    names: List[str] = []
    for n in workflow.get("nodes") or []:
        if isinstance(n, dict) and n.get("name"):
            names.append(str(n["name"]))
    user = json.dumps(
        {
            "user_instruction": instruction,
            "existing_node_names": names,
        },
        ensure_ascii=False,
    )
    raw = _complete_messages(
        client,
        model,
        [
            {"role": "system", "content": PLAN_SYSTEM},
            {"role": "user", "content": user},
        ],
        max_tokens=600,
    )
    try:
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


def run_insert_widget(
    workflow: JSONDict,
    instruction: str,
    *,
    model: str,
    api_key: str,
    base_url: Optional[str] = None,
) -> JSONDict:
    from insert_pipeline import (
        NodeSchemaStore,
        apply_insert_splice,
        apply_langchain_tool_location_heuristic,
        build_neighbor_context,
        build_phase0_splice_messages,
        build_phase1_messages,
        build_phase2_messages,
        coerce_to_langchain_tool_node_type,
        deep_merge_parameters,
        default_phase1_system_prompt,
        default_phase2_system_prompt,
        extract_template_workflow,
        format_template_main_graph_for_llm,
        infer_openai_node_parameters_from_instruction,
        location_is_resolvable_on_template,
        merge_parameters_with_defaults,
        parameter_defaults_from_schema,
        parse_insert_instruction,
        parse_phase0_splice_json,
        parse_phase1_json,
        parse_phase2_json,
    )
    from n8n_type_version_fix import resolve_insert_type_version

    client = OpenAI(api_key=api_key, base_url=base_url or None)
    dbg = insert_pipeline_debug_enabled()
    if dbg:
        _ins_trace("START", f"instruction ({len(instruction)} chars):\n{instruction}")

    plan = _plan_insert_header(client, model, workflow, instruction)
    ins_name = str(plan.get("inserted_node_name") or "New node").strip() or "New node"
    tail = str(plan.get("tail_sentence") or "").strip()
    if not tail.lower().startswith(("after ", "before ", "between ")):
        tail = ""
    decl = plan.get("declared_node_type")
    decl_s = str(decl).strip() if decl else ""

    parts = [f'Insert the node "{ins_name}"']
    if decl_s:
        parts.append(f'of type "{decl_s}"')
    if tail:
        parts.append(tail.rstrip("."))
    head = " ".join(parts) + "."

    if dbg:
        _ins_trace(
            "Planner output (JSON)",
            json.dumps(plan, ensure_ascii=False, indent=2),
        )
        _ins_trace("Parsed insert head (before template)", head)

    full_text = head + "\n\nTemplate:\n" + json.dumps(workflow, ensure_ascii=False)
    pinfo = parse_insert_instruction(full_text)
    base_ih = str(pinfo.get("instruction_head") or head).strip()
    if instruction.strip():
        pinfo["instruction_head"] = (
            "Original user request (follow explicit resource/operation and any details here):\n"
            f"{instruction.strip()}\n\n"
            f"Planner-resolved insert line:\n{base_ih}"
        )
    template = extract_template_workflow(full_text) or workflow
    loc: JSONDict = pinfo.get("location") if isinstance(pinfo.get("location"), dict) else {}

    if dbg:
        _ins_trace(
            "Location from instruction head (regex)",
            json.dumps(loc, ensure_ascii=False, indent=2),
        )

    store = NodeSchemaStore()
    catalog = store.build_catalog_text(max_lines=400)
    types_list: List[str] = (
        [decl_s] if decl_s and store.resolve_path(decl_s) else ([] if decl_s else [])
    )

    phase0_probe: JSONDict = {"attempted": False, "accepted": False}
    if template and isinstance(loc, dict) and str(loc.get("kind") or "") in ("", "unknown"):
        phase0_probe["attempted"] = True
        graph_txt = format_template_main_graph_for_llm(template)
        hint = ""
        p0m = build_phase0_splice_messages(
            instruction_head=pinfo.get("instruction_head") or head,
            graph_text=graph_txt,
            regex_location_hint=hint,
        )
        phase0_raw = _complete_messages(client, model, p0m, max_tokens=900)
        loc_llm = parse_phase0_splice_json(phase0_raw)
        if dbg:
            _ins_trace(
                "Phase 0 splice — raw model output",
                (phase0_raw or "")[:120_000] + ("…[truncated]" if len(phase0_raw or "") > 120_000 else ""),
            )
            _ins_trace("Phase 0 splice — parsed JSON", json.dumps(loc_llm or {}, ensure_ascii=False, indent=2))
        if loc_llm and location_is_resolvable_on_template(template, loc_llm):
            loc = loc_llm
            phase0_probe["accepted"] = True

    if not types_list:
        p1m = build_phase1_messages(
            instruction_head=pinfo.get("instruction_head") or head,
            catalog_text=catalog,
            system_prompt=default_phase1_system_prompt(),
        )
        if dbg:
            _ins_trace(
                f"Phase 1 — catalog excerpt (first 24k chars of {len(catalog)} total)",
                catalog[:24000] + ("…[truncated]" if len(catalog) > 24000 else ""),
            )
        phase1_raw = _complete_messages(client, model, p1m, max_tokens=500)
        types_list, _ = parse_phase1_json(phase1_raw)
        if dbg:
            _ins_trace("Phase 1 — raw model output", phase1_raw or "")
            _ins_trace("Phase 1 — parsed selected_types", json.dumps(types_list, ensure_ascii=False))

    chosen_type = types_list[0] if types_list else None
    if not chosen_type or not store.resolve_path(chosen_type):
        return {
            "ok": False,
            "step": "phase1",
            "message": "Could not resolve node type for insert (phase1).",
            "phase0": phase0_probe,
        }

    type_before_coerce = chosen_type
    chosen_type = coerce_to_langchain_tool_node_type(store, instruction, chosen_type)
    if dbg:
        _ins_trace(
            "After LangChain tool coercion",
            f"type_before_coerce={type_before_coerce!r}\nchosen_type={chosen_type!r}",
        )

    loc_before_heur = json.dumps(loc, ensure_ascii=False)
    if template and isinstance(loc, dict):
        loc_h, heur_changed = apply_langchain_tool_location_heuristic(
            template,
            loc,
            declared_node_type=chosen_type,
        )
        if dbg:
            _ins_trace(
                "LangChain tool_for_agent heuristic",
                f"heur_changed={heur_changed}\nloc_before={loc_before_heur}\nloc_after={json.dumps(loc_h, ensure_ascii=False)}",
            )
        if heur_changed and location_is_resolvable_on_template(template, loc_h):
            loc = loc_h

    if chosen_type.endswith(".openAi") or ".openAi" in chosen_type:
        oa_hints = infer_openai_node_parameters_from_instruction(instruction)
        if oa_hints:
            uo = pinfo.get("user_parameter_override")
            if not isinstance(uo, dict):
                uo = {}
            pinfo["user_parameter_override"] = deep_merge_parameters(oa_hints, uo)

    sch = store.load_schema(chosen_type)
    defaults = parameter_defaults_from_schema(sch)
    compact = store.compact_schema_for_llm(chosen_type)
    nbor = build_neighbor_context(template or {}, loc or {})
    user_ov = pinfo.get("user_parameter_override")
    if not isinstance(user_ov, dict):
        user_ov = None

    p2m = build_phase2_messages(
        instruction_head=pinfo.get("instruction_head") or head,
        inserted_node_name=str(pinfo.get("inserted_node_name") or ins_name),
        node_type=chosen_type,
        compact_schema=compact,
        neighbor_context=nbor,
        positional_hints="",
        user_parameter_json=user_ov,
        system_prompt=default_phase2_system_prompt(),
    )
    phase2_raw = _complete_messages(client, model, p2m, max_tokens=4096)
    if dbg:
        _ins_trace(
            "Phase 2 — compact_schema (chars)",
            f"{len(compact)} chars\n" + (compact[:80_000] + "…[truncated]" if len(compact) > 80000 else compact),
        )
        _ins_trace("Phase 2 — neighbor_context", nbor)
        if user_ov:
            _ins_trace("Phase 2 — user_parameter_override", json.dumps(user_ov, ensure_ascii=False, indent=2))
        _ins_trace(
            "Phase 2 — raw model output",
            (phase2_raw or "")[:120_000] + ("…[truncated]" if len(phase2_raw or "") > 120_000 else ""),
        )
    p2 = parse_phase2_json(phase2_raw)
    if not p2:
        return {
            "ok": False,
            "step": "phase2_parse",
            "message": "Model output was not valid JSON for phase 2.",
            "phase0": phase0_probe,
            "raw_preview": (phase2_raw or "")[:800],
        }

    # Always emit a node: treat clarify or missing mode as patch (best-effort parameters).
    if str(p2.get("mode") or "").lower() == "clarify":
        p2 = {**p2, "mode": "patch"}

    params_llm = p2.get("parameters")
    if not isinstance(params_llm, dict):
        params_llm = {}
    merged = merge_parameters_with_defaults(params_llm, defaults)
    if user_ov:
        merged = deep_merge_parameters(merged, user_ov)
    schema_v = sch.get("version") if isinstance(sch, dict) else None
    tv_f = resolve_insert_type_version(chosen_type, p2.get("typeVersion"), schema_v)

    name_ins = str(pinfo.get("inserted_node_name") or ins_name)
    try:
        merged_wf = apply_insert_splice(
            template,
            new_node_name=name_ins,
            node_type=chosen_type,
            parameters=merged,
            location=loc or {},
            type_version=tv_f,
        )
    except Exception as e:
        return {
            "ok": False,
            "step": "merge",
            "message": str(e),
            "phase0": phase0_probe,
        }

    if dbg:
        _ins_trace(
            "Final splice",
            f"node_name={name_ins!r} type={chosen_type!r}\nlocation={json.dumps(loc or {}, ensure_ascii=False)}\nmerged_parameters={json.dumps(merged, ensure_ascii=False, indent=2)[:50_000]}",
        )

    return {
        "ok": True,
        "step": "done",
        "modified_workflow": merged_wf,
        "phase0": phase0_probe,
        "chosen_type": chosen_type,
    }
