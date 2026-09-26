#!/usr/bin/env python3
"""Summarize local vs cloud benchmark results for thesis tables."""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "results"
ALIGN = [
    "001", "002", "003", "004", "005", "007", "008", "009",
    "016", "041", "047", "048", "065", "069", "071", "082",
]


def read_score(runner: str, op_dir: str, case_id: str):
    p = ROOT / runner / op_dir / case_id / "score.json"
    if not p.exists():
        meta = ROOT / runner / op_dir / case_id / "meta.json"
        err = "not_run"
        if meta.exists():
            m = json.loads(meta.read_text(encoding="utf-8"))
            err = (m.get("error") or "no_score")[:80]
        return None, err
    return json.loads(p.read_text(encoding="utf-8")), None


def struct_ok(score: dict) -> bool:
    c = (score.get("insert_detail") or {}).get("checks") or {}
    if not c:
        return False
    return bool(
        c.get("node_name_present", {}).get("ok")
        and c.get("node_type_match", {}).get("ok")
        and c.get("splice_position", {}).get("ok")
    )


def insert_summary(runner: str, prefix: str, align_only: bool = True):
    ids = [f"{prefix}-{n}" for n in ALIGN] if align_only else []
    if not align_only:
        base = ROOT / runner / "insert"
        ids = sorted(
            d.name for d in base.iterdir() if d.is_dir() and d.name.startswith(prefix)
        )
    tiers = Counter()
    struct = 0
    scored = 0
    success = 0
    missing = []
    for cid in ids:
        s, err = read_score(runner, "insert", cid)
        if s is None:
            missing.append((cid, err))
            continue
        scored += 1
        tier = s.get("insert_status_label") or "?"
        tiers[tier] += 1
        if s.get("success"):
            success += 1
        if struct_ok(s):
            struct += 1
    return {
        "runner": runner,
        "prefix": prefix,
        "scored": scored,
        "total": len(ids),
        "struct_ok": struct,
        "success": success,
        "tiers": dict(tiers),
        "missing": missing,
    }


def delete_summary(runner: str):
    base = ROOT / runner / "delete"
    if not base.exists():
        return {"runner": runner, "scored": 0, "success": 0, "tiers": {}}
    tiers = Counter()
    success = 0
    scored = 0
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        s, _ = read_score(runner, "delete", d.name)
        if s is None:
            continue
        scored += 1
        if s.get("success"):
            success += 1
        # delete scores may not have insert_status_label
        tier = s.get("insert_status_label")
        if not tier:
            tier = "Success" if s.get("success") else "Fail"
        tiers[tier] += 1
    return {
        "runner": runner,
        "scored": scored,
        "success": success,
        "tiers": dict(tiers),
    }


def main():
    out = {"insert_full": [], "insert_partial": [], "delete": []}
    for runner in ("local", "cloud"):
        out["insert_full"].append(insert_summary(runner, "insert-full"))
        out["insert_partial"].append(insert_summary(runner, "insert-partial"))
        out["delete"].append(delete_summary(runner))
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
