#!/usr/bin/env python3
"""Build paired delete/insert cases from the 60 creation benchmark gold workflows."""

from __future__ import annotations

import copy
import hashlib
import json
import random
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

JSONDict = Dict[str, Any]

BENCHMARK_ROOT = Path(__file__).resolve().parent.parent
CREATION_MANIFEST = BENCHMARK_ROOT / "data/manifest_creation.json"
DATA_ROOT = BENCHMARK_ROOT / "data/creation_edit"
MANIFEST_PATH = BENCHMARK_ROOT / "data/manifest_creation_edit.json"
SEED_BASE = 42


def _sha256_json(obj: Any) -> str:
    s = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _node_by_name(workflow: JSONDict, name: str) -> Optional[JSONDict]:
    for n in workflow.get("nodes") or []:
        if isinstance(n, dict) and n.get("name") == name:
            return n
    return None


def _is_sticky(node: JSONDict) -> bool:
    return "stickynote" in str(node.get("type") or "").lower()


def _is_trigger(node: JSONDict) -> bool:
    t = str(node.get("type") or "").lower()
    name = str(node.get("name") or "").lower()
    if "trigger" in t or t.endswith("trigger"):
        return True
    if t in {
        "n8n-nodes-base.manualtrigger",
        "n8n-nodes-base.webhook",
        "n8n-nodes-base.cron",
        "n8n-nodes-base.scheduletrigger",
        "n8n-nodes-base.formtrigger",
    }:
        return True
    if "webhook" in t or "cron" in t or "schedule" in t:
        return True
    if "on clicking" in name or "trigger" in name:
        return True
    return False


def _list_main_edges(workflow: JSONDict) -> List[Tuple[str, str, int, int]]:
    edges: List[Tuple[str, str, int, int]] = []
    conns = workflow.get("connections")
    if not isinstance(conns, dict):
        return edges
    for src, outputs in conns.items():
        if not isinstance(outputs, dict):
            continue
        main = outputs.get("main")
        if not isinstance(main, list):
            continue
        for out_idx, targets in enumerate(main):
            if not isinstance(targets, list):
                continue
            for t in targets:
                if not isinstance(t, dict):
                    continue
                tgt = t.get("node")
                if not tgt:
                    continue
                edges.append((str(src), str(tgt), int(out_idx), int(t.get("index", 0) or 0)))
    return edges


def _incoming_main(workflow: JSONDict) -> Dict[str, List[Tuple[str, int]]]:
    inc: Dict[str, List[Tuple[str, int]]] = {}
    for src, tgt, out_idx, _ in _list_main_edges(workflow):
        inc.setdefault(tgt, []).append((src, out_idx))
    return inc


def _outgoing_main(workflow: JSONDict) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    for src, tgt, out_idx, _ in _list_main_edges(workflow):
        if out_idx != 0:
            continue
        out.setdefault(src, []).append(tgt)
    return out


def _remove_node_and_cleanup(workflow: JSONDict, node_name: str) -> Tuple[JSONDict, JSONDict]:
    wf = copy.deepcopy(workflow)
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        return wf, {"action": "delete_node", "error": "nodes_missing", "target_node": node_name}

    deleted_node = None
    kept: List[JSONDict] = []
    for n in nodes:
        if isinstance(n, dict) and n.get("name") == node_name:
            deleted_node = n
        elif isinstance(n, dict):
            kept.append(n)
    wf["nodes"] = kept

    edges = _list_main_edges(wf)
    incoming = [(src, out_idx) for (src, tgt, out_idx, _) in edges if tgt == node_name]
    outgoing = [tgt for (src, tgt, out_idx, _) in edges if src == node_name and out_idx == 0]

    bridged = False
    if len(incoming) == 1 and outgoing:
        pred, pred_out_idx = incoming[0]
        conns = wf.get("connections", {})
        pred_outputs = conns.get(pred, {})
        main = pred_outputs.get("main")
        if isinstance(main, list) and pred_out_idx < len(main) and isinstance(main[pred_out_idx], list):
            new_targets: List[JSONDict] = []
            for t in main[pred_out_idx]:
                if isinstance(t, dict) and t.get("node") == node_name:
                    for succ in outgoing:
                        new_targets.append({"node": succ, "type": "main", "index": 0})
                else:
                    new_targets.append(t)
            main[pred_out_idx] = new_targets
            bridged = True

    conns = wf.get("connections")
    if isinstance(conns, dict):
        conns.pop(node_name, None)
        for _src, outputs in list(conns.items()):
            if not isinstance(outputs, dict):
                continue
            for out_type, out_lists in list(outputs.items()):
                if not isinstance(out_lists, list):
                    continue
                for i, targets in enumerate(out_lists):
                    if not isinstance(targets, list):
                        continue
                    out_lists[i] = [
                        t
                        for t in targets
                        if not (isinstance(t, dict) and t.get("node") == node_name)
                    ]

    edit_spec: JSONDict = {
        "action": "delete_node",
        "target_node": node_name,
        "bridged": bridged,
        "incoming_main": [{"from": s, "output_index": oi} for (s, oi) in incoming],
        "outgoing_main_output0": outgoing,
    }
    if deleted_node is not None:
        edit_spec["deleted_node_type"] = deleted_node.get("type")
    return wf, edit_spec


def _choose_deletable_nodes(workflow: JSONDict) -> List[str]:
    names: List[str] = []
    for n in workflow.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        name = n.get("name")
        if not name or _is_sticky(n) or _is_trigger(n):
            continue
        names.append(str(name))
    return names


def _outgoing_main_all(workflow: JSONDict) -> Dict[str, List[Tuple[str, int]]]:
    out: Dict[str, List[Tuple[str, int]]] = {}
    for src, tgt, out_idx, _ in _list_main_edges(workflow):
        out.setdefault(src, []).append((tgt, out_idx))
    return out


def _is_linear_main_chain_node(workflow: JSONDict, name: str) -> bool:
    """Exactly one main predecessor and one main successor — no parallel fan-out on that edge."""
    inc = _incoming_main(workflow)
    preds = inc.get(name, [])
    outs = _outgoing_main_all(workflow).get(name, [])
    if len(preds) != 1 or len(outs) != 1:
        return False
    pred, pred_out = preds[0]
    tgt, _ = outs[0]
    pred_outs = _outgoing_main_all(workflow).get(pred, [])
    if len(pred_outs) != 1:
        return False
    return pred_outs[0][0] == name


def _has_direct_main_edge(workflow: JSONDict, src: str, tgt: str) -> bool:
    for s, t, _, _ in _list_main_edges(workflow):
        if s == src and t == tgt:
            return True
    return False


def _pick_delete_target(rng: random.Random, workflow: JSONDict) -> Optional[str]:
    deletables = _choose_deletable_nodes(workflow)
    if not deletables:
        return None
    linear = [nm for nm in deletables if _is_linear_main_chain_node(workflow, nm)]
    pool = linear if linear else []
    if not pool:
        return None
    return rng.choice(pool)


def _derive_insert_neighbors(
    original: JSONDict, deleted_node_name: str
) -> Optional[Tuple[str, str]]:
    inc = _incoming_main(original)
    outs = _outgoing_main_all(original)
    preds = inc.get(deleted_node_name, [])
    succs = outs.get(deleted_node_name, [])
    if len(preds) == 1 and len(succs) == 1:
        src, _ = preds[0]
        tgt, _ = succs[0]
        return src, tgt
    return None


def _insert_instruction_and_location(
    name: str, node_type: str, src: str, tgt: str, deleted_wf: JSONDict
) -> Optional[Tuple[str, JSONDict]]:
    """Always use between on a direct main edge on the insert base (post-delete) workflow."""
    if not _has_direct_main_edge(deleted_wf, src, tgt):
        return None
    phrase = f'between "{src}" and "{tgt}"'
    return (
        f'Insert the node "{name}" of type "{node_type}" {phrase}.',
        {"kind": "between", "between": [src, tgt]},
    )


def functional_node_count(wf: JSONDict) -> int:
    n = 0
    for node in wf.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        if "stickynote" in str(node.get("type") or "").lower():
            continue
        n += 1
    return n


def write_case_files(case_dir: Path, base: JSONDict, gold: JSONDict, instruction: str) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "base.json").write_text(
        json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (case_dir / "gold.json").write_text(
        json.dumps(gold, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (case_dir / "instruction.txt").write_text(instruction.strip() + "\n", encoding="utf-8")


def build_from_creation_case(
    creation_entry: JSONDict, rng: random.Random
) -> Optional[Tuple[JSONDict, JSONDict]]:
    create_id = creation_entry["id"]
    m = re.match(r"create-(\d+)$", create_id)
    if not m:
        return None
    idx = int(m.group(1))
    gold_path = BENCHMARK_ROOT / creation_entry["gold_path"]
    if not gold_path.is_file():
        print(f"Warning: missing gold for {create_id}", file=sys.stderr)
        return None

    original = json.loads(gold_path.read_text(encoding="utf-8"))
    if not isinstance(original, dict):
        return None

    target = _pick_delete_target(rng, original)
    if not target:
        print(f"Warning: no deletable node for {create_id}", file=sys.stderr)
        return None

    deleted_node = _node_by_name(original, target)
    if not isinstance(deleted_node, dict):
        return None

    neighbors = _derive_insert_neighbors(original, target)
    if not neighbors:
        print(f"Warning: no insert neighbors for {create_id} (target={target})", file=sys.stderr)
        return None
    src, tgt = neighbors
    name = str(deleted_node.get("name") or target)
    node_type = str(deleted_node.get("type") or "")

    deleted_wf, edit_spec = _remove_node_and_cleanup(original, target)
    delete_instr = f'Delete the node "{target}".'

    ins_pair = _insert_instruction_and_location(name, node_type, src, tgt, deleted_wf)
    if not ins_pair:
        print(
            f"Warning: insert base has no direct edge {src!r} -> {tgt!r} for {create_id}",
            file=sys.stderr,
        )
        return None
    insert_instr, loc_meta = ins_pair

    del_id = f"create-del-{idx:03d}"
    ins_id = f"create-ins-{idx:03d}"

    del_dir = DATA_ROOT / "delete" / del_id
    ins_dir = DATA_ROOT / "insert" / ins_id
    write_case_files(del_dir, original, deleted_wf, delete_instr)
    write_case_files(ins_dir, deleted_wf, original, insert_instr)

    oracle_base = {
        "deleted_node": {"name": name, "type": node_type},
        "location": loc_meta,
        "edit_spec": edit_spec,
        "source_create_id": create_id,
        "template_workflow_hash": _sha256_json(original),
    }

    del_entry: JSONDict = {
        "id": del_id,
        "operation": "delete",
        "scoring_operation": "delete",
        "index": idx,
        "source_create_id": create_id,
        "complexity": creation_entry.get("complexity"),
        "gold_name": creation_entry.get("gold_name"),
        "instruction": delete_instr,
        "instruction_path": f"data/creation_edit/delete/{del_id}/instruction.txt",
        "base_path": f"data/creation_edit/delete/{del_id}/base.json",
        "gold_path": f"data/creation_edit/delete/{del_id}/gold.json",
        "gold_kind": "workflow",
        "functional_node_count": functional_node_count(original),
        "deleted_node_name": target,
        "dataset_profile": "creation_edit_paired",
        "oracle_clue": {
            **oracle_base,
            "task": "delete",
            "deleted_node_name": target,
            "instruction_meta": {"variant": "by_name", "node": target},
        },
    }

    ins_entry: JSONDict = {
        "id": ins_id,
        "operation": "insert-full",
        "scoring_operation": "insert",
        "index": idx,
        "source_create_id": create_id,
        "complexity": creation_entry.get("complexity"),
        "gold_name": creation_entry.get("gold_name"),
        "instruction": insert_instr,
        "instruction_path": f"data/creation_edit/insert/{ins_id}/instruction.txt",
        "base_path": f"data/creation_edit/insert/{ins_id}/base.json",
        "gold_path": f"data/creation_edit/insert/{ins_id}/gold.json",
        "gold_kind": "workflow",
        "functional_node_count": functional_node_count(original),
        "inserted_node_name": name,
        "inserted_node_type": node_type,
        "dataset_profile": "creation_edit_paired",
        "oracle_clue": {
            **oracle_base,
            "task": "insert_full",
            "output_kind": "workflow",
            "expected_workflow_hash": _sha256_json(original),
        },
    }

    return del_entry, ins_entry


def main() -> int:
    if not CREATION_MANIFEST.is_file():
        print(f"Missing {CREATION_MANIFEST} — run prepare_creation_dataset.py first", file=sys.stderr)
        return 1

    creation_manifest = json.loads(CREATION_MANIFEST.read_text(encoding="utf-8"))
    creation_cases = creation_manifest.get("cases") or []

    delete_cases: List[JSONDict] = []
    insert_cases: List[JSONDict] = []
    skipped: List[str] = []

    for c in sorted(creation_cases, key=lambda x: x.get("index", 0)):
        m = re.match(r"create-(\d+)$", c.get("id", ""))
        seed = SEED_BASE + (int(m.group(1)) if m else 0)
        rng = random.Random(seed)
        built = build_from_creation_case(c, rng)
        if not built:
            skipped.append(c.get("id", "?"))
            continue
        del_entry, ins_entry = built
        delete_cases.append(del_entry)
        insert_cases.append(ins_entry)
        print(
            f"  {c['id']} → {del_entry['id']} / {ins_entry['id']}  "
            f"node={del_entry['deleted_node_name']}"
        )

    manifest = {
        "version": 1,
        "dataset_profile": "creation_edit_paired",
        "description": (
            "Paired delete/insert from 60 creation gold workflows: "
            "delete removes one linear main-path node (name-only instruction); "
            "insert restores it (name + type + between placement, no parameters)."
        ),
        "source_manifest": str(CREATION_MANIFEST),
        "seed_base": SEED_BASE,
        "counts": {
            "delete": len(delete_cases),
            "insert": len(insert_cases),
            "skipped": len(skipped),
        },
        "skipped_create_ids": skipped,
        "delete_cases": delete_cases,
        "insert_cases": insert_cases,
        "cases": delete_cases + insert_cases,
    }

    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {len(delete_cases)} delete + {len(insert_cases)} insert cases")
    print(f"Manifest: {MANIFEST_PATH}")
    if skipped:
        print(f"Skipped: {', '.join(skipped)}", file=sys.stderr)
    return 0 if delete_cases else 1


if __name__ == "__main__":
    raise SystemExit(main())
