from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

JSONDict = Dict[str, Any]


def default_phase1_system_prompt() -> str:
    return (
        "You help pick n8n node types for an INSERT instruction.\n"
        "Given the user's instruction and a catalog of official node entries, each line is:\n"
        "  <type> — <displayName> — <short description of what the node does>\n"
        "Return ONLY valid JSON: {\"selected_types\": [\"<exact type from catalog>\"], \"reason\": \"...\"}.\n"
        "Pick the single best type unless the instruction clearly allows multiple; then list at most 3.\n"
        "Use the description to disambiguate nodes with similar display names.\n"
        "LangChain / AI Agent: If the user wants a **tool** wired under an **AI Agent** (Tool port / "
        "sub-workflow, not the main sequential flow), you MUST pick the catalog entry whose type ends "
        "with ``Tool`` for that integration (e.g. ``n8n-nodes-base.googleSheetsTool``), never the plain "
        "``n8n-nodes-base.googleSheets`` row. Plain integration nodes cannot attach to the agent's Tool port.\n"
        "Types MUST be copied verbatim from the catalog (the first token after '- ' on each line)."
    )


def default_phase2_system_prompt() -> str:
    return (
        "You output JSON for PHASE 2 ONLY: the new node's editable fields as n8n stores them under "
        "that node's \"parameters\" object.\n"
        "This is NOT a full workflow. Do NOT output nodes[], connections{}, or a complete workflow JSON. "
        "Do NOT put node-level fields (name, type, id, position, credentials, webhookId) inside "
        "\"parameters\". Never nest a second \"parameters\" object.\n"
        "You are given: instruction, authoritative compact schema (defaults & properties with options), "
        "neighbor node summaries (parameters excerpts from upstream/downstream nodes), and optional hints.\n"
        "The pipeline ALWAYS inserts a node: you must produce a best-effort patch. Do NOT use mode=clarify "
        "and do not ask the user questions—downstream code cannot block on clarifications.\n"
        "Return ONLY JSON with this shape:\n"
        '{ "mode": "patch", "parameters": { ... }, "typeVersion": <number|null>, "clarify_message": null }\n'
        "The \"parameters\" value must mirror the shape of that node's settings in the n8n UI only.\n"
        "Neighbor-first:\n"
        "- Read the \"Neighbor / anchor nodes\" block and infer binary field names, expressions, URLs, IDs, "
        "and anything the upstream node likely passes through.\n"
        "- If the new node consumes binary/audio/file data, use the schema default (often \"data\") or align "
        "with the upstream neighbor's binary output name from the excerpt.\n"
        "- For dropdown / options fields in the compact schema, set the parameter to the exact \"value\" "
        "from the matching option's UI \"name\"; never invent values not listed.\n"
        "- If the instruction (especially \"Original user request\") names resource/operation (e.g. OpenAI "
        "audio + transcribe), set those exact enum values in parameters.\n"
        "- Fill any remaining gaps with schema defaults and reasonable placeholders consistent with neighbors; "
        "prefer a runnable guess over leaving required-shaped objects empty.\n"
        "Google Sheets (``googleSheets`` / ``googleSheetsTool``): **documentId** is the **spreadsheet file** in Drive; "
        "**sheetName** is a **tab inside** that file. Never put a workbook/file title into sheetName unless it is "
        "literally a tab name; file titles belong in documentId (url/id/list).\n"
        "The instruction may use prose: \"Set parameters such as: foo.bar = \\\"...\\\"\" without a JSON "
        "block—still mirror every assignment in parameters.\n"
        "Avoid these common mistakes: (1) HTTP Request: wrong responseFormat vs siblings in the template "
        "(e.g. json vs file) when consuming JSON APIs; (2) Extract from File / Spreadsheet: wrong "
        "operation or fileFormat vs the file type in the story; (3) HubSpot / Jira: dropping "
        "additionalFields sub-keys or expressions; (4) LangChain nodes: omitting whole options, "
        "attributes, messages, or jsonSchemaExample blocks; (5) emitting null for a field the "
        "instruction sets—use the exact expression string instead; (6) swapping enum-like toggles "
        "(debugHelper category, emailFormat, schemaType, etc.) with an unrelated default.\n"
        "No markdown fences or prose outside JSON."
    )


def default_phase2_system_prompt_workflow_oracle() -> str:
    """
    For eval slices where the gold answer is always a full workflow (no ask/clarify rows).
    Encourages a completed patch so merges always run; errors surface as param/graph mismatch vs oracle.
    """
    return (
        "You output JSON for PHASE 2 ONLY: the new node's fields as n8n stores them in that node's "
        "\"parameters\" object.\n"
        "This is NOT a full workflow. Do NOT output nodes[], connections{}, or workflow-level JSON. "
        "Do NOT put name, type, id, position, credentials, or webhookId inside \"parameters\". "
        "Never nest a second \"parameters\" key inside \"parameters\".\n"
        "You are given: instruction, authoritative compact schema (defaults & properties), "
        "neighbor node summaries, and optional positional hints.\n"
        "This evaluation slice expects a finished workflow downstream: ALWAYS use mode=patch.\n"
        "Do not use mode=clarify and do not ask the user questions.\n"
        "Fill any missing fields using schema defaults and reasonable placeholders consistent with "
        "neighbor nodes and expressions already in the instruction.\n"
        "When the instruction or the merged \"Instruction-derived parameter assignments\" block "
        "mentions nested paths (e.g. options.*, additionalFields.*, attributes.*), you MUST include "
        "those parent objects and keys in parameters with the same values/expressions—even if the "
        "compact schema shows them as optional.\n"
        "Copy string expressions exactly as given (including leading ={{ ... }}). Enum-like fields "
        "(responseFormat, operation, fileFormat, schemaType, etc.) MUST match the instruction or "
        "template, not a generic default.\n"
        "Instruction prose often uses \"Set parameters such as: ... = ...\" (comma-separated); treat "
        "those keys as mandatory even when no JSON object appears in the instruction.\n"
        "HTTP Request: if only url is given, infer responseFormat from upstream nodes that parse JSON "
        "in the template—avoid responseFormat=file unless the flow is for binary downloads.\n"
        "Extract from File / Spreadsheet: align operation and fileFormat with the concrete file type "
        "(csv vs xlsx vs xls).\n"
        "Integrations (HubSpot, Jira, …): keep additionalFields and custom field maps complete; copy "
        "expressions verbatim.\n"
        "LangChain (@n8n/n8n-nodes-langchain.*): populate options (e.g. systemMessage), attributes, "
        "messages.messageValues, jsonSchemaExample, etc., when the schema exposes them—not a minimal "
        "shell that drops these objects.\n"
        "Form / Airtop: preserve complex JSON (jsonOutput) and reply text expressions; never replace "
        "a required expression with null.\n"
        "Return ONLY JSON with this shape:\n"
        '{ "mode": "patch", "parameters": { ... }, "typeVersion": <number|null>, "clarify_message": null }\n'
        "No markdown fences or prose outside JSON."
    )


def build_phase1_messages(
    *,
    instruction_head: str,
    catalog_text: str,
    system_prompt: Optional[str] = None,
) -> List[JSONDict]:
    sys = system_prompt or default_phase1_system_prompt()
    user = f"Instruction (partial, template omitted):\n{instruction_head}\n\nNode catalog:\n{catalog_text}\n"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def _summarize_node(wf: JSONDict, name: str, max_param_chars: int = 1200) -> str:
    n = None
    for node in wf.get("nodes") or []:
        if isinstance(node, dict) and node.get("name") == name:
            n = node
            break
    if not n:
        return f"- {name}: (not found in template)"
    params = n.get("parameters")
    p_s = ""
    if isinstance(params, dict):
        try:
            p_s = json.dumps(params, ensure_ascii=False)[:max_param_chars]
        except Exception:
            p_s = str(params)[:max_param_chars]
    return (
        f"- name={n.get('name')} type={n.get('type')} typeVersion={n.get('typeVersion')}\n"
        f"  parameters_excerpt: {p_s}"
    )


def build_neighbor_context(wf: JSONDict, location: JSONDict) -> str:
    names: List[str] = []
    kind = str(location.get("kind") or "")
    if kind == "between":
        pair = location.get("between")
        if isinstance(pair, list) and len(pair) >= 2:
            names = [str(pair[0]), str(pair[1])]
    elif kind == "after":
        a = location.get("after")
        if isinstance(a, str):
            names = [a]
    elif kind in ("supplementary", "tool_for_agent", "langchain_tool", "langchain_attach"):
        tgt = location.get("target") or location.get("agent") or location.get("attach_to")
        if isinstance(tgt, str) and tgt.strip():
            names = [tgt.strip()]
    parts = ["Neighbor / anchor nodes in the template (for context only):"]
    for n in names:
        parts.append(_summarize_node(wf, n))
    return "\n".join(parts)


def build_phase2_messages(
    *,
    instruction_head: str,
    inserted_node_name: str,
    node_type: str,
    compact_schema: str,
    neighbor_context: str,
    positional_hints: str,
    user_parameter_json: Optional[JSONDict],
    system_prompt: Optional[str] = None,
) -> List[JSONDict]:
    sys = system_prompt or default_phase2_system_prompt()
    user_bits = [
        f"Instruction head:\n{instruction_head}\n",
        f"New node display name (use exactly in workflow, must match): {inserted_node_name}\n",
        f"Resolved n8n node type (do not change): {node_type}\n",
        "Compact authoritative schema JSON:\n" + compact_schema + "\n",
        neighbor_context + "\n",
    ]
    if positional_hints.strip():
        user_bits.append("Positional / graph hints:\n" + positional_hints + "\n")
    if user_parameter_json:
        user_bits.append(
            "Instruction-derived parameter assignments (from \"Set parameters to: {...}\" JSON and/or "
            "parsed prose \"Set parameters such as: ...\"). Each path here is merged into the final "
            "workflow after your patch—still OUTPUT them inside patch.parameters so the JSON matches "
            "what will be executed:\n"
            + json.dumps(user_parameter_json, ensure_ascii=False, indent=2)
        )
    user = "\n".join(user_bits)
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def parse_phase1_json(text: str) -> Tuple[List[str], str]:
    """Returns (selected_types, raw)."""
    try:
        obj = json.loads(text.strip())
    except Exception:
        # try first {...}
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                obj = json.loads(text[start : end + 1])
            except Exception:
                return [], text
        else:
            return [], text
    if not isinstance(obj, dict):
        return [], text
    sel = obj.get("selected_types")
    if isinstance(sel, list):
        return [str(x) for x in sel if x], text
    one = obj.get("selected_type")
    if isinstance(one, str) and one:
        return [one], text
    return [], text


def parse_phase2_json(text: str) -> Optional[JSONDict]:
    t = text.strip()
    try:
        obj = json.loads(t)
        return obj if isinstance(obj, dict) else None
    except Exception:
        pass
    start = t.find("{")
    end = t.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(t[start : end + 1])
            return obj if isinstance(obj, dict) else None
        except Exception:
            return None
    return None
