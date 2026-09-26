#!/usr/bin/env python3
"""Backward-compatible wrapper — see scoring/score_edit.py and scoring/cli.py."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scoring.score_edit import main, score_case  # noqa: F401

if __name__ == "__main__":
    raise SystemExit(main())
