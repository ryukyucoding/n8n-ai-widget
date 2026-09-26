#!/usr/bin/env python3
"""Build 60-case creation benchmark: low/med/high × 20 from S1 testing JSONL."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

BENCHMARK_ROOT = Path(__file__).resolve().parent.parent
_N8N_DIR = BENCHMARK_ROOT.parent.parent.parent
_DEFAULT_JSONL_ROOT = (
    _N8N_DIR / "n8n_json_schema" / "data"
    / "n8n_workflow_template_for_fine-tune" / "S1_ft_original_description"
)
JSONL_ROOT = Path(os.environ.get("S1_JSONL_ROOT", _DEFAULT_JSONL_ROOT)).expanduser().resolve()
DATA_DIR = BENCHMARK_ROOT / "data" / "creation"
MANIFEST_PATH = BENCHMARK_ROOT / "data" / "manifest_creation.json"
MANIFEST_300_PATH = BENCHMARK_ROOT / "data" / "manifest_creation_300.json"

REQ_PREFIX_RE = re.compile(r"^需求描述：\s*", re.MULTILINE)

PROFILE_SPECS = [
    {
        "profile": "low",
        "src": JSONL_ROOT / "testing_data_low_100.jsonl",
        "start_index": 1,
        "jsonl_offset": 0,
        "limit": 10,
    },
    {
        "profile": "low",
        "src": JSONL_ROOT / "testing_data_low_100.jsonl",
        "start_index": 31,
        "jsonl_offset": 10,
        "limit": 10,
    },
    {
        "profile": "med",
        "src": JSONL_ROOT / "testing_data_med_100.jsonl",
        "start_index": 11,
        "jsonl_offset": 0,
        "limit": 10,
    },
    {
        "profile": "med",
        "src": JSONL_ROOT / "testing_data_med_100.jsonl",
        "start_index": 41,
        "jsonl_offset": 10,
        "limit": 10,
    },
    {
        "profile": "high",
        "src": JSONL_ROOT / "testing_data_high_100.jsonl",
        "start_index": 21,
        "jsonl_offset": 0,
        "limit": 10,
    },
    {
        "profile": "high",
        "src": JSONL_ROOT / "testing_data_high_100.jsonl",
        "start_index": 51,
        "jsonl_offset": 10,
        "limit": 10,
    },
]

# Full S1 test JSONL: 100 low + 100 med + 100 high → create-001..300
FULL_300_SPECS = [
    {
        "profile": "low",
        "src": JSONL_ROOT / "testing_data_low_100.jsonl",
        "start_index": 1,
        "jsonl_offset": 0,
        "limit": 100,
    },
    {
        "profile": "med",
        "src": JSONL_ROOT / "testing_data_med_100.jsonl",
        "start_index": 101,
        "jsonl_offset": 0,
        "limit": 100,
    },
    {
        "profile": "high",
        "src": JSONL_ROOT / "testing_data_high_100.jsonl",
        "start_index": 201,
        "jsonl_offset": 0,
        "limit": 100,
    },
]

# Alternate JSONL rows when the default row cannot yield a paired delete/insert case.
CASE_JSONL_OVERRIDES: Dict[int, Tuple[str, int]] = {
    39: ("low", 20),
    45: ("med", 21),
}

JSONL_BY_PROFILE = {
    "low": JSONL_ROOT / "testing_data_low_100.jsonl",
    "med": JSONL_ROOT / "testing_data_med_100.jsonl",
    "high": JSONL_ROOT / "testing_data_high_100.jsonl",
}


def load_jsonl_row(path: Path, row_index: int) -> Dict[str, Any]:
    """Load a single row by 0-based line index."""
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            if i == row_index:
                return json.loads(line)
    raise IndexError(f"row {row_index} not found in {path}")


def load_jsonl(path: Path, offset: int = 0, limit: int | None = None) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            if i < offset:
                continue
            rows.append(json.loads(line))
            if limit is not None and len(rows) >= limit:
                break
    return rows


def extract_messages(row: Dict[str, Any]) -> tuple[str, str, Dict[str, Any]]:
    messages = row.get("messages") or []
    system = ""
    user = ""
    for m in messages:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role == "system":
            system = content
        elif role == "user":
            user = content
        elif role == "assistant":
            gold = json.loads(content)
            if not isinstance(gold, dict):
                raise ValueError("assistant content is not a workflow object")
            return system, user, gold
    raise ValueError("row missing assistant gold workflow")


def cloud_instruction(system: str, user: str) -> str:
    """Text to paste into Cloud AI Builder (matches fine-tune user turn)."""
    body = REQ_PREFIX_RE.sub("", user).strip()
    if system:
        return f"{system.strip()}\n\n{body}"
    return body


def functional_node_count(wf: Dict[str, Any]) -> int:
    n = 0
    for node in wf.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        t = str(node.get("type") or "")
        if "stickynote" in t.lower():
            continue
        n += 1
    return n


def write_case(
    *,
    case_index: int,
    profile: str,
    src: Path,
    row: Dict[str, Any],
    row_offset: int,
) -> Dict[str, Any]:
    case_id = f"create-{case_index:03d}"
    source_id = row.get("id", row_offset)
    system, user, gold = extract_messages(row)
    instr = cloud_instruction(system, user)

    case_dir = DATA_DIR / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "gold.json").write_text(
        json.dumps(gold, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (case_dir / "instruction.txt").write_text(instr, encoding="utf-8")
    (case_dir / "prompt.json").write_text(
        json.dumps({"system": system, "user": user}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    empty_base = {
        "name": f"benchmark-{case_id}",
        "nodes": [],
        "connections": {},
        "settings": {"executionOrder": "v1"},
    }
    (case_dir / "base.json").write_text(
        json.dumps(empty_base, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return {
        "id": case_id,
        "operation": "create",
        "scoring_operation": "create",
        "index": case_index,
        "complexity": profile,
        "source_row_id": source_id,
        "source_jsonl": str(src),
        "instruction": instr,
        "instruction_path": f"data/creation/{case_id}/instruction.txt",
        "base_path": f"data/creation/{case_id}/base.json",
        "gold_path": f"data/creation/{case_id}/gold.json",
        "gold_kind": "workflow",
        "gold_name": gold.get("name") or case_id,
        "functional_node_count": functional_node_count(gold),
        "dataset_profile": f"S1_ft_original_description_{profile}",
    }


def build_chunk(spec: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = load_jsonl(
        spec["src"],
        offset=int(spec.get("jsonl_offset") or 0),
        limit=spec["limit"],
    )
    cases: List[Dict[str, Any]] = []
    for i, row in enumerate(rows):
        case_index = spec["start_index"] + i
        profile = spec["profile"]
        src = spec["src"]
        row_offset = int(spec.get("jsonl_offset") or 0) + i
        override = CASE_JSONL_OVERRIDES.get(case_index)
        if override:
            profile, row_offset = override
            src = JSONL_BY_PROFILE[profile]
            row = load_jsonl_row(src, row_offset)
        cases.append(
            write_case(
                case_index=case_index,
                profile=profile,
                src=src,
                row=row,
                row_offset=row_offset,
            )
        )
    return cases


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--scale",
        choices=["60", "300"],
        default="60",
        help="60 = mixed 20×3 benchmark; 300 = full low/med/high × 100 JSONL rows",
    )
    ap.add_argument(
        "--profile",
        choices=["low", "med", "high", "all"],
        default="all",
        help="Which complexity slice to build (default: all for selected scale)",
    )
    args = ap.parse_args()

    scale = args.scale
    if scale == "300":
        specs = FULL_300_SPECS
        out_manifest = MANIFEST_300_PATH
        desc = (
            "Creation from-scratch: 100 low + 100 med + 100 high templates; "
            "gold = S1 testing_data_*_100.jsonl assistant workflow."
        )
        profile_specs_meta = FULL_300_SPECS
    else:
        specs = PROFILE_SPECS
        out_manifest = MANIFEST_PATH
        desc = (
            "Creation from-scratch: 20 low + 20 med + 20 high templates; "
            "gold = S1 test assistant workflow."
        )
        profile_specs_meta = PROFILE_SPECS

    if args.profile != "all":
        specs = [s for s in specs if s["profile"] == args.profile]

    built: List[Dict[str, Any]] = []
    for spec in specs:
        built.extend(build_chunk(spec))

    existing: List[Dict[str, Any]] = []
    if out_manifest.exists() and args.profile != "all":
        existing = json.loads(out_manifest.read_text(encoding="utf-8")).get("cases") or []
    elif out_manifest.exists() and args.profile == "all" and scale == "60":
        pass
    by_id = {c["id"]: c for c in existing}
    for c in built:
        by_id[c["id"]] = c
    cases = sorted(by_id.values(), key=lambda c: c["index"])

    manifest = {
        "version": 2 if scale == "60" else 3,
        "dataset_profile": "S1_ft_original_description_mixed",
        "description": desc,
        "scale": int(scale),
        "profiles": [
            {
                "complexity": s["profile"],
                "source_jsonl": str(s["src"]),
                "jsonl_offset": s.get("jsonl_offset", 0),
                "case_range": f"create-{s['start_index']:03d}..create-{s['start_index'] + s['limit'] - 1:03d}",
            }
            for s in profile_specs_meta
        ],
        "count": len(cases),
        "cases": cases,
    }

    out_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(cases)} cases under {DATA_DIR}")
    for spec in specs:
        lo = spec["start_index"]
        hi = lo + spec["limit"] - 1
        off = int(spec.get("jsonl_offset") or 0)
        print(
            f"  {spec['profile']:4s} create-{lo:03d}..create-{hi:03d} "
            f"(jsonl rows {off + 1}-{off + spec['limit']}) ← {spec['src'].name}"
        )
    print(f"Manifest: {out_manifest}")


if __name__ == "__main__":
    main()
