"""Task decomposer for `/agent/run` (single LLM call → ordered tasks)."""

from __future__ import annotations

from .decompose_v2 import decompose_v2, decompose_widget_turn

__all__ = ["decompose_v2", "decompose_widget_turn"]
