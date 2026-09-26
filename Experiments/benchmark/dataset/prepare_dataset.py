#!/usr/bin/env python3
"""
Extract simplified name-based benchmark cases from n8n_workflow_generator_package.

Design (v2 — simple / name-based instructions):
  - delete (100): 50× "Delete the node \"X\"." + 50× "Remove the node \"X\"."
  - insert (300): 100 full + 100 ask + 100 partial (partial params; gold = full workflow)
  - modify (100): name-quoted edits only (no left/right ordinal instructions)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

JSONDict = Dict[str, Any]

BENCHMARK_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = BENCHMARK_ROOT / "data"
DEFAULT_PKG = Path(
    "/Users/angelicawang/Documents/n8n/n8n_json_schema/n8n_workflow_generator_package"
)

POSITIONAL_RE = re.compile(
    r"from the (left|right)|top branch|bottom branch|\d+(st|nd|rd|th) node",
    re.I,
)
INSERT_PARAMS_RE = re.compile(r"Set parameters to:\s*(.+?)(?:\.\s*$|\.\n)", re.S)


def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def split_template_input(s: str) -> Tuple[str, JSONDict]:
    mark = "Template:\n"
    idx = s.rfind(mark)
    if idx < 0:
        mark = "Template:\r\n"
        idx = s.rfind(mark)
    if idx < 0:
        raise ValueError("input missing Template: block")
    head = s[:idx].strip()
    wf = json.loads(s[idx + len(mark) :].strip())
    if not isinstance(wf, dict):
        raise ValueError("template is not a JSON object")
    return head, wf


def join_template_input(head: str, base: JSONDict) -> str:
    return f"{head}\n\nTemplate:\n{json.dumps(base, ensure_ascii=False)}"


def instruction_line(head: str) -> str:
    for line in head.splitlines():
        line = line.strip()
        if line:
            return line
    return head.strip()


def load_jsonl(path: Path, limit: Optional[int] = None) -> List[JSONDict]:
    rows: List[JSONDict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
            if limit is not None and len(rows) >= limit:
                break
    return rows


def load_oracle_clues(path: Path) -> Dict[str, JSONDict]:
    out: Dict[str, JSONDict] = {}
    if not path.exists():
        return out
    for r in load_jsonl(path):
        sha = r.get("input_sha256")
        if isinstance(sha, str) and sha:
            out[sha] = r
    return out


def write_case_files(case_dir: Path, base: JSONDict, gold: Any) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "base.json").write_text(
        json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    if isinstance(gold, dict):
        (case_dir / "gold.json").write_text(
            json.dumps(gold, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    else:
        (case_dir / "gold.json").write_text(
            json.dumps({"_ask_text": str(gold)}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def delete_target_name(clue: JSONDict) -> str:
    name = clue.get("deleted_node_name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    edit_spec = clue.get("edit_spec") or {}
    if isinstance(edit_spec.get("target_node"), str):
        return str(edit_spec["target_node"])
    meta = clue.get("instruction_meta") or {}
    if isinstance(meta.get("node"), str):
        return str(meta["node"])
    raise ValueError("delete clue missing target node name")


def rewrite_delete_instruction(node_name: str, verb: str) -> str:
    if verb not in ("Delete", "Remove"):
        raise ValueError(f"unsupported delete verb: {verb}")
    return f'{verb} the node "{node_name}".'


def insert_location_phrase(clue: JSONDict, fallback_head: str) -> str:
    loc = clue.get("location") or {}
    between = loc.get("between")
    if isinstance(between, list) and len(between) == 2:
        a, b = str(between[0]), str(between[1])
        return f'between "{a}" and "{b}"'

    for pattern in (
        r'between\s+"([^"]+)"\s+and\s+"([^"]+)"',
        r'after\s+"([^"]+)"',
        r'before\s+"([^"]+)"',
    ):
        m = re.search(pattern, fallback_head, re.I)
        if m:
            return m.group(0)
    return 'between "Previous Node" and "Next Node"'


def rewrite_insert_instruction(
    *,
    clue: JSONDict,
    original_head: str,
    variant: str,
) -> str:
    deleted = clue.get("deleted_node") or {}
    node_name = str(deleted.get("name") or "")
    node_type = str(deleted.get("type") or "")
    if not node_name:
        m = re.search(r'Insert the node "([^"]+)"', original_head)
        if m:
            node_name = m.group(1)
    loc_phrase = insert_location_phrase(clue, original_head)

    if variant == "ask":
        return f'Insert the node "{node_name}" {loc_phrase}.'

    params_m = INSERT_PARAMS_RE.search(original_head)
    params_blob = params_m.group(1).strip().rstrip(".") if params_m else "{}"

    type_m = re.search(r'of type "([^"]+)"', original_head)
    if type_m:
        node_type = type_m.group(1)

    if variant == "full":
        return (
            f'Insert the node "{node_name}" of type "{node_type}". '
            f"Set parameters to: {params_blob}."
        )

    return (
        f'Insert the node "{node_name}" of type "{node_type}" {loc_phrase}. '
        f"Set parameters to: {params_blob}."
    )


def is_name_based_modify(head: str) -> bool:
    if POSITIONAL_RE.search(head):
        return False
    return bool(re.search(r'"[^"]+"', head))


def scoring_operation(operation: str) -> str:
    if operation.startswith("insert-"):
        return "insert"
    return operation


def add_case(
    cases: List[JSONDict],
    *,
    case_id: str,
    operation: str,
    index: int,
    head: str,
    base: JSONDict,
    gold: Any,
    source_input_sha256: str,
    instruction_subtype: Optional[str] = None,
    oracle_clue: Optional[JSONDict] = None,
    source_row: Optional[JSONDict] = None,
) -> None:
    if operation.startswith("insert-"):
        case_dir = DATA_DIR / "insert" / case_id
    else:
        case_dir = DATA_DIR / operation / case_id

    write_case_files(case_dir, base, gold)
    # Instruction text only — never includes the Template / workflow JSON block.
    instr = head.strip()
    entry: JSONDict = {
        "id": case_id,
        "operation": operation,
        "scoring_operation": scoring_operation(operation),
        "index": index,
        "instruction": instr,
        "instruction_full": instr,
        "input_sha256": sha256_text(join_template_input(head, base)),
        "source_input_sha256": source_input_sha256,
        "base_path": str(case_dir.relative_to(BENCHMARK_ROOT) / "base.json"),
        "gold_path": str(case_dir.relative_to(BENCHMARK_ROOT) / "gold.json"),
        "gold_kind": "ask" if isinstance(gold, str) else "workflow",
        "dataset_profile": "simple_name_based",
    }
    if instruction_subtype:
        entry["instruction_subtype"] = instruction_subtype
    if oracle_clue:
        entry["oracle_clue"] = oracle_clue
    if source_row:
        entry["source"] = {
            "original_instruction": instruction_line(split_template_input(source_row["input"])[0]),
        }
    cases.append(entry)


def main() -> int:
    pkg = Path(os.environ.get("N8N_EVAL_PACKAGE", DEFAULT_PKG))
    if not pkg.is_dir():
        print(f"N8N_EVAL_PACKAGE not found: {pkg}", file=sys.stderr)
        return 1

    style_dir = pkg / "outputs/edit_testing_data_training_style"
    delete_path = style_dir / "delete_testing_data.jsonl"
    insert_paths = {
        "full": style_dir / "insert_testing_data.jsonl",
        "ask": style_dir / "insert_testing_data_ask.jsonl",
        "partial": style_dir / "insert_testing_data_partial.jsonl",
    }
    modify_path = pkg / "outputs/modify_training_data.jsonl"
    clues_path = style_dir / "oracle_clues.jsonl"

    required = [delete_path, modify_path, clues_path, *insert_paths.values()]
    for p in required:
        if not p.is_file():
            print(f"Missing source: {p}", file=sys.stderr)
            return 1

    clues = load_oracle_clues(clues_path)
    cases: List[JSONDict] = []

    # --- delete: 50 Delete + 50 Remove (name only) ---
    delete_rows = load_jsonl(delete_path)
    for i, row in enumerate(delete_rows, 1):
        orig_sha = sha256_text(row["input"])
        clue = clues.get(orig_sha)
        if not clue:
            print(f"Warning: no clue for delete row {i}", file=sys.stderr)
            continue
        _, base = split_template_input(row["input"])
        target = delete_target_name(clue)
        verb = "Delete" if i <= 50 else "Remove"
        head = rewrite_delete_instruction(target, verb)
        add_case(
            cases,
            case_id=f"delete-{i:03d}",
            operation="delete",
            index=i,
            head=head,
            base=base,
            gold=row["output"],
            source_input_sha256=orig_sha,
            instruction_subtype="delete_verb" if verb == "Delete" else "remove_verb",
            oracle_clue=clue,
            source_row=row,
        )

    # --- insert: 100 × (full, ask, partial) ---
    full_insert_rows = load_jsonl(insert_paths["full"])
    for variant, path in insert_paths.items():
        rows = load_jsonl(path)
        op = f"insert-{variant}"
        for i, row in enumerate(rows, 1):
            orig_sha = sha256_text(row["input"])
            clue = clues.get(orig_sha)
            orig_head, base = split_template_input(row["input"])
            if clue:
                head = rewrite_insert_instruction(
                    clue=clue, original_head=orig_head, variant=variant
                )
            else:
                head = orig_head

            gold = row["output"]
            case_clue = clue
            if variant == "partial":
                full_row = full_insert_rows[i - 1]
                full_gold = full_row.get("output")
                if isinstance(full_gold, dict):
                    gold = full_gold
                    if case_clue:
                        case_clue = {
                            **case_clue,
                            "output_kind": "workflow",
                            "gold_workflow_ref": f"insert-full-{i:03d}",
                        }
                else:
                    print(
                        f"Warning: insert-partial-{i:03d} — no workflow gold from insert-full",
                        file=sys.stderr,
                    )

            add_case(
                cases,
                case_id=f"insert-{variant}-{i:03d}",
                operation=op,
                index=i,
                head=head,
                base=base,
                gold=gold,
                source_input_sha256=orig_sha,
                instruction_subtype=variant,
                oracle_clue=case_clue,
                source_row=row,
            )

    # --- modify: first 100 name-based (no positional wording) ---
    modify_count = 0
    for row in load_jsonl(modify_path):
        head, base = split_template_input(row["input"])
        if not is_name_based_modify(head):
            continue
        modify_count += 1
        add_case(
            cases,
            case_id=f"modify-{modify_count:03d}",
            operation="modify",
            index=modify_count,
            head=head,
            base=base,
            gold=row["output"],
            source_input_sha256=sha256_text(row["input"]),
            instruction_subtype="name_based",
            source_row=row,
        )
        if modify_count >= 100:
            break

    if modify_count < 100:
        print(f"Warning: only found {modify_count} name-based modify rows", file=sys.stderr)

    counts: JSONDict = {}
    for c in cases:
        op = c["operation"]
        counts[op] = counts.get(op, 0) + 1

    manifest = {
        "version": 2,
        "dataset_profile": "simple_name_based",
        "description": (
            "Simplified benchmark: delete/remove by node name; insert full/ask/partial by node name; "
            "modify with quoted node names only."
        ),
        "source_package": str(pkg),
        "counts": {
            **counts,
            "delete_total": counts.get("delete", 0),
            "insert_total": sum(v for k, v in counts.items() if k.startswith("insert-")),
            "modify_total": counts.get("modify", 0),
            "total": len(cases),
        },
        "cases": cases,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = DATA_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(cases)} cases to {manifest_path}")
    print(json.dumps(manifest["counts"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
