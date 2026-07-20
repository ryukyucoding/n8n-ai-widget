"""Standalone creation benchmark scoring (no external eval package required)."""

from __future__ import annotations

import sys
from pathlib import Path

SCORING_ROOT = Path(__file__).resolve().parent


def setup_path() -> Path:
    """Add scoring root to sys.path so ``evaluation.*`` imports resolve."""
    root = str(SCORING_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    return SCORING_ROOT
