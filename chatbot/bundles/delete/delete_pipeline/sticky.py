"""Detect n8n sticky note (annotation) nodes; align with evaluation normalizer heuristics."""

from __future__ import annotations

from typing import Any, Dict

JSONDict = Dict[str, Any]


def is_sticky_note_node(node: JSONDict) -> bool:
    t = (node.get("type") or "") if isinstance(node, dict) else ""
    return "stickynote" in str(t).lower()
