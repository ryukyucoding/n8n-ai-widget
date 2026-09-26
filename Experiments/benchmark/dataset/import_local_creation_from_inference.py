#!/usr/bin/env python3
"""Import fine-tune inference predictions into local creation benchmark results."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

BENCHMARK_ROOT = Path(__file__).resolve().parent.parent
JSONL_ROOT = Path(
    "/Users/angelicawang/Documents/n8n/n8n_json_schema/data/"
    "n8n_workflow_template_for_fine-tune/S1_ft_original_description"
)
MANIFEST = BENCHMARK_ROOT / "data/manifest_creation.json"
RESULTS = BENCHMARK_ROOT / "results/local/create"
DEFAULT_MODEL = "ft:gpt-4.1-2025-04-14:widm:s1-original-desc-41:DmUZN4iU"
VENV_PY = BENCHMARK_ROOT / ".venv/bin/python"

TIER_PATHS = {
    "low": JSONL_ROOT / "inference_low/predictions.jsonl",
    "med": JSONL_ROOT / "inference_med50/predictions.jsonl",
    "high": JSONL_ROOT / "inference_high50/predictions.jsonl",
}


def load_jsonl_rows(path: Path, limit: int) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                rows.append({"_parse_error": str(e), "prediction": None})
            if len(rows) >= limit:
                break
    return rows


def score_case(case_id: str, gold_path: Path, pred_path: Path) -> dict:
    score_path = RESULTS / case_id / "score.json"
    py = str(VENV_PY if VENV_PY.exists() else "python3.12")
    proc = subprocess.run(
        [
            py,
            str(BENCHMARK_ROOT / "score_creation.py"),
            "--gold",
            str(gold_path),
            "--pred",
            str(pred_path),
            "--out",
            str(score_path),
        ],
        capture_output=True,
        text=True,
    )
    if score_path.exists():
        return json.loads(score_path.read_text(encoding="utf-8"))
    return {"success": False, "error": proc.stderr or proc.stdout}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit-per-tier", type=int, default=10)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    cases = manifest.get("cases") or []

    by_tier_rows = {
        tier: load_jsonl_rows(path, args.limit_per_tier)
        for tier, path in TIER_PATHS.items()
    }

    stats = {"imported": 0, "scored": 0, "missing_pred": 0, "errors": 0}

    for case in cases:
        cid = case["id"]
        tier = case.get("complexity")
        idx = int(case.get("index", 0))
        if tier not in by_tier_rows:
            continue
        tier_idx = idx - {"low": 1, "med": 11, "high": 21}[tier]
        if tier_idx < 0 or tier_idx >= len(by_tier_rows[tier]):
            continue

        out_dir = RESULTS / cid
        pred_path = out_dir / "pred.json"
        score_path = out_dir / "score.json"
        if not args.force and pred_path.exists() and score_path.exists():
            print(f"[skip] {cid}")
            continue

        row = by_tier_rows[tier][tier_idx]
        pred = row.get("prediction")
        out_dir.mkdir(parents=True, exist_ok=True)

        meta = {
            "caseId": cid,
            "operation": "create",
            "mode": "local_finetune_import",
            "model": row.get("model") or DEFAULT_MODEL,
            "source_predictions": str(TIER_PATHS[tier]),
            "source_row_index": tier_idx,
            "filename": row.get("filename"),
            "usage": row.get("usage"),
            "parse_ok": pred is not None,
        }
        (out_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        if not isinstance(pred, dict):
            stats["missing_pred"] += 1
            print(f"[missing] {cid} — no parsed prediction in inference cache")
            continue

        pred_path.write_text(json.dumps(pred, ensure_ascii=False, indent=2), encoding="utf-8")
        stats["imported"] += 1

        gold_path = BENCHMARK_ROOT / case["gold_path"]
        score = score_case(cid, gold_path, pred_path)
        if score.get("success") or score.get("summary"):
            stats["scored"] += 1
            sm = score.get("summary") or {}
            print(
                f"[OK] {cid}  node_f1={sm.get('node_f1')} conn_f1={sm.get('connection_f1')} "
                f"matched_conn_f1={sm.get('matched_connection_f1')} param={sm.get('parameter_accuracy')}"
            )
        else:
            stats["errors"] += 1
            print(f"[FAIL] {cid} score: {score.get('error', '?')}")

    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
