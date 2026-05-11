from __future__ import annotations

import builtins
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

JSONDict = Dict[str, Any]

try:
    from n8n_type_version_fix import normalize_node_after_llm_modify
except ImportError:

    def normalize_node_after_llm_modify(node: JSONDict) -> JSONDict:
        return node


from .apply_node import apply_modified_node
from .extract_context import extract_target_and_neighbors
from .node_schema_store import get_schema_store


def _eprint(*args: Any, **kwargs: Any) -> None:
    """Debug traces must go to stderr so stdout stays valid JSON for the Node bridge."""
    kwargs.setdefault("file", sys.stderr)
    builtins.print(*args, **kwargs)


def modify_pipeline_debug_enabled() -> bool:
    """Set ``WIDGET_MODIFY_DEBUG=1`` or ``N8N_MODIFY_DEBUG=1`` to print full resolve/modify traces to stderr."""
    v = (
        os.environ.get("WIDGET_MODIFY_DEBUG")
        or os.environ.get("N8N_MODIFY_DEBUG")
        or ""
    ).strip().lower()
    return v in ("1", "true", "yes", "all", "debug")


def _trace_sep(title: str) -> None:
    line = "=" * 72
    _eprint(f"\n{line}\n[modify-pipeline] {title}\n{line}", flush=True)


def _trace_block(label: str, text: str) -> None:
    n = len(text)
    trunc = "[truncated]" in text if label.lower().startswith("node_schema") else False
    extra = "  (contains '[truncated]' marker from schema builder)" if trunc else ""
    _eprint(f"\n--- {label} (chars={n}){extra} ---\n{text}", flush=True)

# Returns chosen node name(s) after ambiguous / not_found, or None to abort.
UserConfirmFn = Callable[[JSONDict], Optional[List[str]]]

# (system_prompt, user_payload, max_new_tokens) -> model text (JSON expected)
TextCompleteFn = Callable[[str, str, int], str]

# Each entry: { "call": "resolve" | "modify", "node": str|None, "model": str, "usage": {prompt_tokens, completion_tokens, total_tokens} }
OpenAiUsageLog = List[JSONDict]


def build_node_catalog(wf: JSONDict, *, max_param_keys: int = 12) -> List[JSONDict]:
    out: List[JSONDict] = []
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        return out
    for n in nodes:
        if not isinstance(n, dict) or not n.get("name"):
            continue
        p = n.get("parameters")
        pkeys: List[str] = []
        if isinstance(p, dict):
            pkeys = list(p.keys())[:max_param_keys]
        out.append(
            {
                "name": n.get("name"),
                "type": n.get("type"),
                "typeVersion": n.get("typeVersion"),
                "parameter_keys": pkeys,
            }
        )
    return out


def _first_json_object(text: str) -> Optional[JSONDict]:
    if not text or not str(text).strip():
        return None
    t = str(text).strip()
    try:
        v = json.loads(t)
        return v if isinstance(v, dict) else None
    except Exception:
        pass
    start = t.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(t)):
        ch = t[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    v = json.loads(t[start : i + 1])
                    return v if isinstance(v, dict) else None
                except Exception:
                    return None
    return None


RESOLVE_SYSTEM = """You map user edit instructions to n8n workflow node(s) to change.
The workflow is described as a list of nodes with: name, type, typeVersion, parameter_keys.

Reply with a single JSON object (no markdown):
{
  "resolution": "found" | "not_found" | "ambiguous",
  "node_name": string | null,
  "node_names": [ string, ... ] | null,
  "candidates": [ { "name": string, "type": string, "reason": string } ],
  "rationale": string
}

Rules:
- "found": the instruction clearly targets one or more specific nodes; set node_names to every node that must be edited
  (or a single name in node_name for backward-only callers). If only one node, you may set node_name OR put one entry in node_names.
- "not_found": no node in the catalog plausibly matches.
- "ambiguous": you cannot map the instruction to a specific set of nodes; set candidates to up to 5 entries; null node_name(s).
- All names must appear in the provided catalog. No duplicates in node_names; order by mention in the user instruction."""


def _google_sheets_modify_addon(context: JSONDict) -> str:
    """n8n distinguishes **Drive spreadsheet file** vs **tab inside the file**; models often confuse them."""
    tn = context.get("target_node")
    if not isinstance(tn, dict):
        return ""
    ty = str(tn.get("type") or "").lower()
    if "googlesheets" not in ty:
        return ""
    return """

### Google Sheets nodes (``googleSheets`` / ``googleSheetsTool``) — required semantics
- **typeVersion**: For n8n recent releases, Google Sheets uses **v3+** (commonly **4.5–4.7**). Do **not** emit ``1`` unless you are certain the workflow already uses a valid v1 export; if unsure, omit ``typeVersion`` so the server can pick a safe default.
- **documentId** = the **Spreadsheet file** in Google Drive (the whole workbook). Use ``mode: "url"`` + the full
  ``https://docs.google.com/spreadsheets/d/<id>/edit`` URL if the user pasted a link; use ``mode: "id"`` + the
  spreadsheet id substring if they gave an id; use ``{"mode": "list", "value": ""}`` if they only give a **file title**
  (they must pick the file in the n8n UI—do not invent ids).
- **sheetName** = a **worksheet tab inside** that spreadsheet (e.g. ``Sheet1``, ``工作表1``). It **loads after** documentId.
  Never put the **spreadsheet file title** (e.g. the user’s workbook name like 記帳2026) into **sheetName** unless they
  explicitly mean a tab whose name is exactly that string.
- If the user names only the **workbook/file** and not a tab: keep **sheetName** as ``{"mode": "list", "value": ""}`` (or
  preserve the existing tab selection) and put nothing into sheetName that is really a document title.
- The compact schema lists properties from many branches; **only keep parameters keys that belong to the current**
  ``resource`` + ``operation`` **and** the target UI—drop unrelated keys (e.g. clear/toDelete/title from other operations)
  rather than copying every default-looking field into the output.
"""


def _default_modify_system(focus_node_name: str, *, context: Optional[JSONDict] = None) -> str:
    base = f"""You are editing ONE n8n node in a workflow. The node you must change is named: "{focus_node_name}".
You receive: the full user instruction, the current target node JSON, optional ``node_schema_compact`` (authoritative
property list from n8n: displayName, name, type, and options with UI ``name`` + API ``value``), neighbor nodes, and
the connection subgraph.

Return a single JSON object: {{ "node": <full n8n node object> }}
The "node" must be the complete updated node (parameters, type, typeVersion, position, etc. as needed).

Rules:
- Apply ONLY the parts of the user instruction that refer to the node named "{focus_node_name}". Ignore instructions meant for other nodes.
- When ``node_schema_compact`` is present: for any field whose schema lists ``options`` (dropdowns, operations, resources),
  you MUST set ``parameters.<field>`` to an exact ``value`` from that list. Match the user's wording to the option's UI
  ``name`` (e.g. "Send and Wait for Response"), then copy the paired ``value`` (e.g. sendAndWait)—never invent camelCase
  strings like sendAndWaitForResponse that are not in the schema.
- If the schema is missing for this node type, keep enum-like fields consistent with the existing target node and instruction.
- Do not add or remove connection edges; the program will not use your connection ideas for the global graph.
- Keep the same node "name" and "id" as the input target if present (the program may enforce them).
- Keep other fields stable unless the edit for this node requires them."""
    addon = _google_sheets_modify_addon(context) if context else ""
    return base + addon


def _parse_resolved_node_names(resolution: JSONDict) -> List[str]:
    out: List[str] = []
    seen: set = set()
    if isinstance(resolution.get("node_names"), list):
        for x in resolution["node_names"]:
            if isinstance(x, str) and x and x not in seen:
                seen.add(x)
                out.append(x)
    if isinstance(resolution.get("node_name"), str) and resolution["node_name"]:
        n = resolution["node_name"]
        if n not in seen:
            out.append(n)
    return out


@dataclass
class TwoPhaseConfig:
    model: str
    temperature: float = 0.0
    max_tokens_resolve: int = 1024
    max_tokens_modify: int = 8192
    api_key: Optional[str] = None
    base_url: Optional[str] = None


def _client(cfg: TwoPhaseConfig) -> Any:
    from openai import OpenAI

    return OpenAI(api_key=cfg.api_key, base_url=cfg.base_url or None)


def _usage_from_response(resp: Any) -> Optional[JSONDict]:
    u = getattr(resp, "usage", None)
    if u is None:
        return None
    try:
        return {
            "prompt_tokens": int(getattr(u, "prompt_tokens", 0) or 0),
            "completion_tokens": int(getattr(u, "completion_tokens", 0) or 0),
            "total_tokens": int(getattr(u, "total_tokens", 0) or 0),
        }
    except Exception:
        return None


def append_openai_usage(
    log: OpenAiUsageLog,
    *,
    call: str,
    model: str,
    usage: Optional[JSONDict],
    node: Optional[str] = None,
) -> None:
    if not usage:
        return
    log.append(
        {
            "call": call,
            "model": model,
            "node": node,
            "usage": usage,
        }
    )


def aggregate_openai_usage(log: OpenAiUsageLog) -> JSONDict:
    """Sum prompt / completion / total tokens for all logged API calls."""
    pin, pout, tot = 0, 0, 0
    for e in log:
        u = e.get("usage")
        if not isinstance(u, dict):
            continue
        pin += int(u.get("prompt_tokens", 0) or 0)
        pout += int(u.get("completion_tokens", 0) or 0)
        tot += int(u.get("total_tokens", 0) or 0)
    return {
        "n_api_calls": len(log),
        "prompt_tokens": pin,
        "completion_tokens": pout,
        "total_tokens": tot if tot else (pin + pout),
    }


def llm_resolve_node(
    *,
    client: Any,
    model: str,
    user_instruction: str,
    catalog: List[JSONDict],
    temperature: float = 0.0,
    max_tokens: int = 1024,
    text_complete: Optional[TextCompleteFn] = None,
    usage_log: Optional[OpenAiUsageLog] = None,
    resolve_system: Optional[str] = None,
    extra_user_fields: Optional[JSONDict] = None,
) -> JSONDict:
    """Resolve which node(s) to edit or delete. Optional ``resolve_system`` / ``extra_user_fields`` used by delete."""
    system = resolve_system or RESOLVE_SYSTEM
    user_obj: JSONDict = {
        "user_instruction": user_instruction,
        "node_catalog": catalog,
    }
    if extra_user_fields:
        user_obj.update(extra_user_fields)
    user = json.dumps(user_obj, ensure_ascii=False)
    dbg = modify_pipeline_debug_enabled()
    if dbg:
        _trace_sep("PHASE 1 — resolve target node(s)")
        _trace_block("RESOLVE_SYSTEM_PROMPT", system)
        _trace_block("RESOLVE_USER_MESSAGE (JSON)", user)
        _eprint(
            f"[modify-pipeline] resolve: model={model!r} max_tokens={max_tokens} "
            f"catalog_nodes={len(catalog)}",
            flush=True,
        )
    resp = None
    if text_complete is not None:
        raw = text_complete(system, user, max_tokens)
    else:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            response_format={"type": "json_object"},
            max_tokens=max_tokens,
        )
        if usage_log is not None:
            append_openai_usage(usage_log, call="resolve", model=model, usage=_usage_from_response(resp))
        raw = resp.choices[0].message.content if resp.choices and resp.choices[0].message else None
        if dbg:
            u = _usage_from_response(resp)
            if u:
                _eprint(f"[modify-pipeline] resolve API usage: {u}", flush=True)
    if dbg:
        _trace_block("RESOLVE_RAW_MODEL_OUTPUT", raw or "")
    parsed = _first_json_object(raw or "")
    if not isinstance(parsed, dict):
        if dbg:
            _eprint("[modify-pipeline] resolve: parse failed, returning not_found", flush=True)
        return {
            "resolution": "not_found",
            "node_name": None,
            "candidates": [],
            "rationale": "llm_response_not_json",
            "raw": raw,
        }
    if dbg:
        _eprint(
            "[modify-pipeline] resolve: parsed JSON keys="
            f"{list(parsed.keys())} resolution={parsed.get('resolution')!r}",
            flush=True,
        )
    return parsed


def llm_modify_node(
    *,
    client: Any,
    model: str,
    user_instruction: str,
    context: JSONDict,
    focus_node_name: str,
    node_schema_compact: Optional[str] = None,
    temperature: float = 0.0,
    max_tokens: int = 8192,
    text_complete: Optional[TextCompleteFn] = None,
    usage_log: Optional[OpenAiUsageLog] = None,
) -> JSONDict:
    """
    One modify LLM call for ``focus_node_name``. The system prompt tells the model to only
    apply the slice of the instruction that applies to this node.
    """
    system = _default_modify_system(focus_node_name, context=context)
    payload = {
        "user_instruction": user_instruction,
        "focus_node_name": focus_node_name,
        "edit_context": context,
    }
    if node_schema_compact:
        payload["node_schema_compact"] = node_schema_compact
    user = json.dumps(payload, ensure_ascii=False)
    dbg = modify_pipeline_debug_enabled()
    if dbg:
        _trace_sep(f'PHASE 2 — modify node "{focus_node_name}"')
        _trace_block("MODIFY_SYSTEM_PROMPT", system)
        _eprint(
            f"[modify-pipeline] modify: model={model!r} max_tokens={max_tokens} "
            f"user_json_chars={len(user)}",
            flush=True,
        )
        _trace_block(
            "USER_INSTRUCTION (verbatim)",
            user_instruction,
        )
        ctx_pretty = json.dumps(context, ensure_ascii=False, indent=2)
        _trace_block(
            "EDIT_CONTEXT (target_node + neighbor_nodes + relevant_connections)",
            ctx_pretty,
        )
        if node_schema_compact:
            _trace_block("node_schema_compact", node_schema_compact)
        else:
            _eprint("\n--- node_schema_compact: <none> ---", flush=True)
        _trace_block(
            "MODIFY_USER_MESSAGE_FULL (same JSON sent to API as user message)",
            user,
        )
    resp = None
    if text_complete is not None:
        raw = text_complete(system, user, max_tokens)
    else:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            response_format={"type": "json_object"},
            max_tokens=max_tokens,
        )
        if usage_log is not None:
            append_openai_usage(
                usage_log,
                call="modify",
                model=model,
                node=focus_node_name,
                usage=_usage_from_response(resp),
            )
        raw = resp.choices[0].message.content if resp.choices and resp.choices[0].message else None
        if dbg:
            u = _usage_from_response(resp)
            if u:
                _eprint(f"[modify-pipeline] modify API usage: {u}", flush=True)
    if dbg:
        _trace_block("MODIFY_RAW_MODEL_OUTPUT", raw or "")
    parsed = _first_json_object(raw or "")
    if not isinstance(parsed, dict) or "node" not in parsed:
        if dbg:
            _eprint("[modify-pipeline] modify: missing node in parsed JSON", flush=True)
        return {"error": "llm_response_missing_node", "raw": raw}
    node = parsed.get("node")
    if not isinstance(node, dict):
        if dbg:
            _eprint("[modify-pipeline] modify: node field not an object", flush=True)
        return {"error": "llm_node_not_object", "raw": raw}
    if dbg:
        params = node.get("parameters")
        pjson = (
            json.dumps(params, ensure_ascii=False, indent=2)
            if isinstance(params, dict)
            else str(params)
        )
        _trace_block("PARSED_OUTPUT_NODE.parameters", pjson)
        _trace_block(
            "PARSED_OUTPUT_NODE (full)",
            json.dumps(node, ensure_ascii=False, indent=2),
        )
    return {"node": node, "raw": raw}


def run_two_phase_modification(
    workflow: JSONDict,
    user_instruction: str,
    *,
    config: TwoPhaseConfig,
    confirmed_node_name: Optional[str] = None,
    confirmed_node_names: Optional[List[str]] = None,
    user_confirm: Optional[UserConfirmFn] = None,
    text_complete: Optional[TextCompleteFn] = None,
) -> JSONDict:
    """
    1) LLM: resolve which node(s) to edit (or not_found / ambiguous), including multi-node.
    2) If ambiguous or not_found, ``user_confirm`` may return a list of exact node names
       (or one; duplicate resolution handling).
    3) For each target name in order: extract context from the *current* workflow, LLM
       modify, merge. Later nodes see updates from earlier merges in ``nodes`` (neighbors/params)
       if relevant.
    4) If ``confirmed_node_name`` is set, use that single name. If ``confirmed_node_names``
       is set (non-empty), skip resolution and use that list. If both are set, ``confirmed_node_names``
       wins.

    If ``text_complete`` is set, it is used for all LLM calls (local / non-OpenAI). Otherwise
    ``TwoPhaseConfig`` is used to build an OpenAI client.
    """
    client: Any
    api_usage_log: OpenAiUsageLog = []
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
                "resolution": {},
                "message": "confirmed_node_names is empty; pass None to use the resolver.",
                "api_usage": [],
                "api_usage_totals": aggregate_openai_usage([]),
            }
        for x in confirmed_node_names:
            if isinstance(x, str) and x and x not in resolved_names:
                resolved_names.append(x)
    elif confirmed_node_name:
        resolved_names = [confirmed_node_name]

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
        )
        status = str(resolution.get("resolution") or "")
        if status == "found":
            resolved_names = _parse_resolved_node_names(resolution)
        if not resolved_names and user_confirm is not None:
            picked = user_confirm(resolution)
            if isinstance(picked, list) and picked:
                resolved_names = [x for x in picked if isinstance(x, str) and x]
                # de-dupe
                res: List[str] = []
                seen2: set = set()
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

    trace = modify_pipeline_debug_enabled()
    if trace:
        _trace_sep("run_two_phase_modification — after resolve")
        _eprint(
            f"[modify-pipeline] resolved_node_names={resolved_names!r}\n"
            f"[modify-pipeline] resolution object: "
            f"{json.dumps(resolution, ensure_ascii=False, indent=2) if resolution else '{}'}",
            flush=True,
        )

    per_node: List[JSONDict] = []
    current = workflow
    for name in resolved_names:
        if trace:
            hit: Optional[JSONDict] = None
            for node in current.get("nodes") or []:
                if isinstance(node, dict) and node.get("name") == name:
                    hit = node
                    break
            _trace_sep(f'Workflow snapshot — node "{name}" before extract/modify')
            if hit:
                nt = hit.get("type")
                _eprint(
                    f"[modify-pipeline] matched node name={name!r} type={nt!r} "
                    f"typeVersion={hit.get('typeVersion')!r}",
                    flush=True,
                )
                try:
                    sp = get_schema_store().resolve_path(str(nt or "").strip())
                    _eprint(f"[modify-pipeline] schema JSON path for this type: {sp}", flush=True)
                except Exception as e:
                    _eprint(f"[modify-pipeline] schema path lookup error: {e}", flush=True)
            else:
                _eprint(f"[modify-pipeline] WARNING: no node named {name!r} in current workflow", flush=True)
        ctx = extract_target_and_neighbors(current, name)
        if ctx.get("error"):
            return {
                "ok": False,
                "step": "extract",
                "resolution": resolution,
                "resolved_node_names": resolved_names,
                "failed_node_name": name,
                "per_node": per_node,
                "context": ctx,
                "api_usage": list(api_usage_log),
                "api_usage_totals": aggregate_openai_usage(api_usage_log),
            }
        schema_text: Optional[str] = None
        tgt = ctx.get("target_node")
        if isinstance(tgt, dict):
            nt = tgt.get("type")
            if isinstance(nt, str) and nt.strip():
                try:
                    schema_text = get_schema_store().compact_schema_for_modify(nt.strip())
                except Exception:
                    schema_text = None
        mod = llm_modify_node(
            client=client,
            model=config.model,
            user_instruction=user_instruction,
            context=ctx,
            focus_node_name=name,
            node_schema_compact=schema_text,
            temperature=config.temperature,
            max_tokens=config.max_tokens_modify,
            text_complete=text_complete,
            usage_log=usage_log_ref,
        )
        if mod.get("error") or "node" not in mod:
            return {
                "ok": False,
                "step": "llm_modify",
                "resolved_node_names": resolved_names,
                "failed_node_name": name,
                "resolution": resolution,
                "per_node": per_node,
                "llm": mod,
                "api_usage": list(api_usage_log),
                "api_usage_totals": aggregate_openai_usage(api_usage_log),
            }
        node_out = mod["node"]
        if isinstance(node_out, dict):
            normalize_node_after_llm_modify(node_out)
        new_wf = apply_modified_node(current, name, node_out)
        per_node.append({"name": name, "ok": True})
        current = new_wf

    out: JSONDict = {
        "ok": True,
        "step": "done",
        "resolution": resolution,
        "resolved_node_names": resolved_names,
        "per_node": per_node,
        "modified_workflow": current,
    }
    if len(resolved_names) == 1:
        out["resolved_node_name"] = resolved_names[0]
    out["api_usage"] = list(api_usage_log)
    out["api_usage_totals"] = aggregate_openai_usage(api_usage_log)
    return out
