"""
When the user asks to add a **LangChain / AI Agent tool** (wires under the agent via ``ai_tool``,
not the main canvas edge), Phase 1 often picks the wrong integration type (e.g. ``googleSheets``
instead of ``googleSheetsTool``). This module detects that intent and coerces to the ``*Tool``
type when the schema store has it.
"""
from __future__ import annotations

import re
from typing import Any


def instruction_requests_langchain_agent_tool(text: str) -> bool:
    """
    True when the user likely wants a sub-node that plugs into an Agent's **Tool** port
    (dashed ``ai_tool`` connection), not a normal main-flow node.
    """
    if not text or not isinstance(text, str):
        return False
    tl = text.lower()
    if "tool" not in tl and "工具" not in text:
        return False
    # Strong signals: tool under / in / for an agent, or explicit LangChain wording
    if re.search(
        r"\b(tool\s+node|sub[- ]?node|plug[- ]?in|langchain\s+tool|ai_tool|under\s+the\s+agent|"
        r"in\s+the\s+agent|for\s+the\s+agent|to\s+the\s+agent|attached\s+to\s+the\s+agent|"
        r"agent's\s+tool|agent\s+tool\s+port|tool\s+port)\b",
        tl,
    ):
        return True
    if re.search(r"\b(ai\s+agent|ai\s+assistant|langchain\s+agent)\b", tl) and re.search(
        r"\b(tool|工具)\b", tl
    ):
        return True
    # "in \"Some Agent Name\" node" style (quoted display name)
    if re.search(r'\bin\s+"[^"]+"\s+node', tl) and re.search(r"\b(tool|工具)\b", tl):
        return True
    return False


def coerce_to_langchain_tool_node_type(store: Any, instruction: str, chosen_type: str) -> str:
    """
    If the user asked for an agent-attached tool and ``chosen_type`` is a base integration
    that has a ``<samePrefix>Tool`` schema, return that Tool type.
    """
    ct = (chosen_type or "").strip()
    if not ct or not instruction_requests_langchain_agent_tool(instruction):
        return ct
    seg = ct.replace("@", "").split(".")[-1].split("/")[-1]
    if seg.endswith("Tool") or seg.lower().endswith("tool"):
        return ct
    candidate = f"{ct}Tool"
    if store.resolve_path(candidate):
        return candidate
    return ct
