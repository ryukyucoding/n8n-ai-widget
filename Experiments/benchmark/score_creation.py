#!/usr/bin/env python3
"""Backward-compatible wrapper — see scoring/score_create.py and scoring/cli.py."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scoring.score_create import evaluate_creation, main  # noqa: F401

if __name__ == "__main__":
    raise SystemExit(main())
