#!/usr/bin/env python3
"""Compare creation benchmark: staged vs FT one-shot vs base model (gpt-4o) one-shot."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results" / "local"
MANIFEST = ROOT / "data" / "manifest_creation.json"

DEFAULT_DIRS = {
    "staged": RESULTS / "create-staged-gpt41",
    "ft_oneshot": RESULTS / "create-semantic",
    "base_oneshot": RESULTS / "create-gpt41-semantic",
}


def mean(values: list[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


def _complexity_map() -> dict[str, str]:
    if not MANIFEST.exists():
        return {}
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {c["id"]: c.get("complexity", "unknown") for c in manifest.get("cases") or []}


def _load_score(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _metrics(score: dict | None) -> dict:
    if not score:
        return {}
    sm = score.get("summary") or {}
    m = score.get("metrics") or {}
    return {
        "node_f1": float(sm.get("node_f1") or m.get("node_type_f1") or 0),
        "connection_f1": float(sm.get("connection_f1") or m.get("connection_f1") or 0),
        "matched_connection_f1": float(
            sm.get("matched_connection_f1") or m.get("matched_connection_f1") or 0
        ),
        "parameter_accuracy": float(
            sm.get("parameter_accuracy") or m.get("avg_parameter_accuracy") or 0
        ),
    }


def _meta_model(path: Path) -> str | None:
    mp = path / "meta.json"
    if not mp.exists():
        return None
    meta = json.loads(mp.read_text(encoding="utf-8"))
    return meta.get("model")


def _load_executability(path: Path) -> dict | None:
    ep = path / "executability.json"
    if not ep.exists():
        return None
    return json.loads(ep.read_text(encoding="utf-8"))


def _exec_metrics(row: dict | None) -> dict:
    if not row:
        return {}
    return {
        "import_ok": bool(row.get("import_ok")),
        "execute_success": bool(row.get("final_execute_success")),
        "runtime_reached": bool(row.get("runtime_reached")),
        "credential_blocked": bool(row.get("credential_blocked")),
        "repair_success": bool(row.get("repair_success")),
        "error_category": row.get("error_category"),
    }


def compare(
    dirs: dict[str, Path],
    case_ids: list[str] | None = None,
) -> dict:
    cmap = _complexity_map()
    available: dict[str, set[str]] = {}
    for label, base in dirs.items():
        if not base.exists():
            available[label] = set()
            continue
        available[label] = {
            d.name for d in base.iterdir() if d.is_dir() and (d / "score.json").exists()
        }

    if case_ids:
        shared = set(case_ids)
    else:
        shared = set.intersection(*available.values()) if all(available.values()) else set()
        if not shared and available.get("staged"):
            shared = available["staged"]
            for label in dirs:
                shared &= available.get(label, set()) | shared

    # Intersection of all three where possible; still report partial rows
    all_three = set.intersection(*(available.get(k, set()) for k in dirs))
    if case_ids:
        all_three = set(case_ids) & all_three

    rows: list[dict] = []
    for cid in sorted(shared):
        row: dict = {"case_id": cid, "complexity": cmap.get(cid, "unknown")}
        for label, base in dirs.items():
            score = _load_score(base / cid / "score.json")
            row[label] = _metrics(score) if score else None
            row[f"{label}_model"] = _meta_model(base / cid)
            row[f"{label}_exec"] = _exec_metrics(_load_executability(base / cid))
        rows.append(row)

    def agg(label: str, ids: set[str]) -> dict:
        vals = {
            "node_f1": [],
            "connection_f1": [],
            "matched_connection_f1": [],
            "parameter_accuracy": [],
        }
        for r in rows:
            if r["case_id"] not in ids:
                continue
            m = r.get(label)
            if not m:
                continue
            for k in vals:
                vals[k].append(m[k])
        return {"n": len(vals["node_f1"]), **{f"{k}_mean": mean(v) for k, v in vals.items()}}

    def wins_param(ids: set[str]) -> dict[str, int]:
        counts = {k: 0 for k in dirs}
        for r in rows:
            if r["case_id"] not in ids:
                continue
            scores = {
                k: (r[k] or {}).get("parameter_accuracy", -1)
                for k in dirs
                if r.get(k)
            }
            if not scores:
                continue
            best = max(scores.values())
            for k, v in scores.items():
                if v == best:
                    counts[k] += 1
        return counts

    def exec_agg(label: str, ids: set[str]) -> dict:
        imports = []
        executes = []
        runtime = []
        cred = []
        repairs = []
        for r in rows:
            if r["case_id"] not in ids:
                continue
            ex = r.get(f"{label}_exec") or {}
            if not ex:
                continue
            imports.append(1 if ex.get("import_ok") else 0)
            executes.append(1 if ex.get("execute_success") else 0)
            runtime.append(1 if ex.get("runtime_reached") else 0)
            cred.append(1 if ex.get("credential_blocked") else 0)
            if ex.get("repair_success"):
                repairs.append(1)
        n = len(imports)
        return {
            "n": n,
            "import_ok_rate": mean(imports) if imports else 0,
            "execute_success_rate": mean(executes) if executes else 0,
            "runtime_reached_rate": mean(runtime) if runtime else 0,
            "credential_blocked_rate": mean(cred) if cred else 0,
            "repair_success_count": len(repairs),
        }

    return {
        "dirs": {k: str(v) for k, v in dirs.items()},
        "available_counts": {k: len(v) for k, v in available.items()},
        "shared_all_three": sorted(all_three),
        "n_shared_all_three": len(all_three),
        "aggregate_all_three": {k: agg(k, all_three) for k in dirs},
        "executability_all_three": {k: exec_agg(k, all_three) for k in dirs},
        "param_wins_all_three": wins_param(all_three),
        "rows": rows,
    }


def _print_table(data: dict) -> None:
    print("=== Creation three-way comparison ===")
    for k, p in data["dirs"].items():
        print(f"  {k}: {p} ({data['available_counts'].get(k, 0)} scored)")
    print(f"  shared (all three): {data['n_shared_all_three']} cases")
    print()

    agg = data["aggregate_all_three"]
    headers = ["metric", "staged", "ft_oneshot", "base_oneshot"]
    print("| metric | staged | ft_oneshot | base_oneshot |")
    print("|--------|--------|------------|--------------|")
    for metric in ("node_f1", "connection_f1", "matched_connection_f1", "parameter_accuracy"):
        key = f"{metric}_mean"
        vals = [agg.get(h, {}).get(key, "-") for h in headers[1:]]
        print(f"| {metric} | " + " | ".join(str(v) for v in vals) + " |")

    wins = data["param_wins_all_three"]
    print()
    print(f"param wins (ties count each): staged={wins.get('staged', 0)}, "
          f"ft={wins.get('ft_oneshot', 0)}, base={wins.get('base_oneshot', 0)}")

    exec_agg = data.get("executability_all_three") or {}
    if any((exec_agg.get(k) or {}).get("n") for k in headers[1:]):
        print()
        print("| executability | staged | ft_oneshot | base_oneshot |")
        print("|---------------|--------|------------|--------------|")
        for metric, key in (
            ("import_ok_rate", "import_ok_rate"),
            ("execute_success_rate", "execute_success_rate"),
            ("runtime_reached_rate", "runtime_reached_rate"),
            ("credential_blocked_rate", "credential_blocked_rate"),
        ):
            vals = [exec_agg.get(h, {}).get(key, "-") for h in headers[1:]]
            print(f"| {metric} | " + " | ".join(str(v) for v in vals) + " |")
    print()

    print("| case | complexity | staged param | ft param | base param | best |")
    print("|------|------------|--------------|----------|------------|------|")
    for r in data["rows"]:
        if r["case_id"] not in data["shared_all_three"]:
            continue
        sp = (r.get("staged") or {}).get("parameter_accuracy")
        fp = (r.get("ft_oneshot") or {}).get("parameter_accuracy")
        bp = (r.get("base_oneshot") or {}).get("parameter_accuracy")
        scores = {"staged": sp, "ft": fp, "base": bp}
        valid = {k: v for k, v in scores.items() if v is not None}
        best = max(valid, key=valid.get) if valid else "-"
        print(
            f"| {r['case_id']} | {r['complexity']} | "
            f"{sp if sp is not None else '-'} | {fp if fp is not None else '-'} | "
            f"{bp if bp is not None else '-'} | {best} |"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged-dir", type=Path, default=DEFAULT_DIRS["staged"])
    parser.add_argument("--ft-dir", type=Path, default=DEFAULT_DIRS["ft_oneshot"])
    parser.add_argument("--base-dir", type=Path, default=DEFAULT_DIRS["base_oneshot"])
    parser.add_argument("--case-id", action="append", dest="case_ids")
    parser.add_argument("--limit", type=int, default=0, help="limit to first N shared cases")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    dirs = {
        "staged": args.staged_dir,
        "ft_oneshot": args.ft_dir,
        "base_oneshot": args.base_dir,
    }
    case_ids = args.case_ids
    if args.limit and not case_ids:
        # will filter after compare
        pass

    data = compare(dirs, case_ids=case_ids)
    if args.limit and not case_ids:
        shared = data["shared_all_three"][: args.limit]
        data = compare(dirs, case_ids=shared)

    if args.json:
        print(json.dumps(data, indent=2))
    else:
        _print_table(data)


if __name__ == "__main__":
    main()
