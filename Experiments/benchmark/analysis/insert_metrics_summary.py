#!/usr/bin/env python3
"""Insert evaluation rates for thesis (no case ids)."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "results"
ALIGN = [
    "001", "002", "003", "004", "005", "006", "007", "008", "009",
    "015", "016", "018", "019", "041", "046", "047", "048", "054",
    "065", "069", "071", "082",
]


def collateral_clean(score: dict) -> bool:
    d = score.get("insert_detail") or {}
    col = (d.get("checks") or {}).get("collateral") or {}
    if col.get("other_nodes_semantically_changed"):
        return False
    if col.get("extra_nodes_beyond_insert"):
        return False
    if col.get("base_nodes_missing_from_pred"):
        return False
    reasons = d.get("ambiguity_reasons") or score.get("insert_ambiguity_reasons") or []
    for tag in ("other_nodes_modified", "extra_nodes_added", "unexpected_node_removals"):
        if tag in reasons:
            return False
    return True


def rates(runner: str, prefix: str) -> dict:
    n = 0
    splice_ok = type_ok = collateral_ok = 0
    coverage_sum = 0.0
    for num in ALIGN:
        cid = f"{prefix}-{num}"
        sp = ROOT / runner / "insert" / cid / "score.json"
        if not sp.exists():
            continue
        s = json.loads(sp.read_text(encoding="utf-8"))
        n += 1
        c = (s.get("insert_detail") or {}).get("checks") or {}
        m = s.get("metrics") or {}
        if c.get("splice_position", {}).get("ok") or m.get("insert_main_neighbors_ok"):
            splice_ok += 1
        if c.get("node_type_match", {}).get("ok") or m.get("inserted_node_type_ok"):
            type_ok += 1
        p = c.get("parameters") or {}
        rate = p.get("coverage_rate")
        if rate is None and m.get("gold_params_subset_ok"):
            rate = 1.0
        coverage_sum += float(rate) if rate is not None else 0.0
        if collateral_clean(s):
            collateral_ok += 1
    pct = lambda x: round(100 * x / n, 1) if n else 0.0
    return {
        "n": n,
        "splice_pct": pct(splice_ok),
        "type_pct": pct(type_ok),
        "params_coverage_mean_pct": round(100 * coverage_sum / n, 1) if n else 0.0,
        "collateral_clean_pct": pct(collateral_ok),
    }


def delete_fail_rates(runner: str) -> dict:
    base = ROOT / runner / "delete"
    if not base.exists():
        return {"n": 0}
    n = fail = 0
    by_type: dict[str, int] = {}
    for d in sorted(base.iterdir()):
        sp = d / "score.json"
        if not sp.exists():
            continue
        s = json.loads(sp.read_text(encoding="utf-8"))
        n += 1
        if not s.get("success"):
            fail += 1
            et = (s.get("metrics") or {}).get("delete_error_type") or "unknown"
            by_type[et] = by_type.get(et, 0) + 1
    return {
        "n": n,
        "fail_pct": round(100 * fail / n, 1) if n else 0,
        "by_type_pct": {k: round(100 * v / fail, 1) if fail else 0 for k, v in by_type.items()},
        "fail": fail,
    }


if __name__ == "__main__":
    out = {}
    for runner in ("local", "cloud"):
        out[runner] = {
            "insert_partial": rates(runner, "insert-partial"),
            "insert_full": rates(runner, "insert-full"),
            "delete": delete_fail_rates(runner),
        }
    print(json.dumps(out, indent=2))
