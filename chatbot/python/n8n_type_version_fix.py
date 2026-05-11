"""Align ``typeVersion`` with n8n:latest for nodes whose bundled schema omits ``version``."""

from __future__ import annotations

import os
from typing import Any, Optional

_GOOGLE_SHEETS_TYPES = frozenset(
    {
        "n8n-nodes-base.googleSheets",
        "n8n-nodes-base.googleSheetsTool",
    }
)


def _env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def google_sheets_default_type_version() -> float:
    """Default for Google Sheets v2 (``version`` array in n8n ``versionDescription.ts``, e.g. up to 4.7)."""
    return _env_float("N8N_GOOGLE_SHEETS_DEFAULT_TYPE_VERSION", 4.7)


def coerce_google_sheets_type_version(reported: Any) -> Optional[float]:
    """
    If ``reported`` is missing or below v3, n8n:latest may show the node as unknown / invalid.
    Return the replacement version, or ``None`` if no change is needed.
    """
    try:
        v = float(reported) if reported is not None else 0.0
    except (TypeError, ValueError):
        v = 0.0
    if v < 3:
        return google_sheets_default_type_version()
    return None


def resolve_insert_type_version(node_type: str, llm_tv: Any, schema_tv: Any) -> float:
    """Phase-2 insert: prefer LLM ``typeVersion``, then schema, with Google Sheets coercion."""
    nt = (node_type or "").strip()
    for candidate in (llm_tv, schema_tv):
        if isinstance(candidate, (int, float)):
            tv = float(candidate)
            if nt in _GOOGLE_SHEETS_TYPES:
                fixed = coerce_google_sheets_type_version(tv)
                return fixed if fixed is not None else tv
            return tv
    if nt in _GOOGLE_SHEETS_TYPES:
        return google_sheets_default_type_version()
    return 1.0


def normalize_node_after_llm_modify(node: dict) -> dict:
    """Fix modify output when the model copies ``typeVersion: 1`` from a broken workflow node."""
    if not isinstance(node, dict):
        return node
    nt = str(node.get("type") or "").strip()
    if nt not in _GOOGLE_SHEETS_TYPES:
        return node
    fixed = coerce_google_sheets_type_version(node.get("typeVersion"))
    if fixed is not None:
        node["typeVersion"] = fixed
    return node
