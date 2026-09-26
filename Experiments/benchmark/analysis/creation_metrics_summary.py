#!/usr/bin/env python3
"""Aggregate creation benchmark scores (cloud/local), optionally by complexity."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"
MANIFEST = ROOT / "data" / "manifest_creation.json"


def mean(values: list[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


def _complexity_map() -> dict[str, str]:
    if not MANIFEST.exists():
        return {}
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {c["id"]: c.get("complexity", "unknown") for c in manifest.get("cases") or []}


def _row_from_score(case_id: str, score: dict, complexity: str) -> dict:
    sm = score.get("summary") or {}
    m = score.get("metrics") or {}
    return {
        "case_id": case_id,
        "complexity": complexity,
        "node_f1": float(sm.get("node_f1") or m.get("node_type_f1") or 0),
        "connection_f1": float(sm.get("connection_f1") or m.get("connection_f1") or 0),
        "matched_connection_f1": float(
            sm.get("matched_connection_f1") or m.get("matched_connection_f1") or 0
        ),
        "parameter_accuracy": float(
            sm.get("parameter_accuracy") or m.get("avg_parameter_accuracy") or 0
        ),
    }


def _aggregate(rows: list[dict]) -> dict:
    if not rows:
        return {"n": 0}
    return {
        "n": len(rows),
        "node_f1_mean": mean([r["node_f1"] for r in rows]),
        "connection_f1_mean": mean([r["connection_f1"] for r in rows]),
        "matched_connection_f1_mean": mean([r["matched_connection_f1"] for r in rows]),
        "parameter_accuracy_mean": mean([r["parameter_accuracy"] for r in rows]),
    }


def summarize(runner: str) -> dict:
    base = RESULTS / runner / "create"
    if not base.exists():
        return {"n": 0}
    cmap = _complexity_map()
    rows: list[dict] = []
    for d in sorted(base.iterdir()):
        sp = d / "score.json"
        if not sp.exists():
            continue
        score = json.loads(sp.read_text(encoding="utf-8"))
        rows.append(_row_from_score(d.name, score, cmap.get(d.name, "unknown")))

    if not rows:
        return {"n": 0}

    by_complexity: dict[str, list[dict]] = {}
    for r in rows:
        by_complexity.setdefault(r["complexity"], []).append(r)

    return {
        **_aggregate(rows),
        "by_complexity": {k: _aggregate(v) for k, v in sorted(by_complexity.items())},
        "cases": rows,
    }


if __name__ == "__main__":
    out = {}
    for runner in ("cloud", "local"):
        out[runner] = summarize(runner)
    print(json.dumps(out, indent=2))
