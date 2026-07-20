"""Workflow normalization and graph helpers for insert evaluation."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

JSONDict = Dict[str, Any]


def json_dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def extract_first_json_object(text: str) -> Optional[JSONDict]:
    if not text:
        return None
    text = text.strip()
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except Exception:
        pass

    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                chunk = text[start : i + 1]
                try:
                    value = json.loads(chunk)
                    return value if isinstance(value, dict) else None
                except Exception:
                    return None
    return None


def normalize_connections(conns: Any) -> Any:
    if not isinstance(conns, dict):
        return conns
    norm: Dict[str, Any] = {}
    for src, outputs in conns.items():
        if not isinstance(outputs, dict):
            norm[str(src)] = outputs
            continue
        out_norm: Dict[str, Any] = {}
        for out_type, out_lists in outputs.items():
            if not isinstance(out_lists, list):
                out_norm[str(out_type)] = out_lists
                continue
            new_lists: List[Any] = []
            for targets in out_lists:
                if not isinstance(targets, list):
                    new_lists.append(targets)
                    continue
                cleaned: List[JSONDict] = []
                for target in targets:
                    if isinstance(target, dict):
                        cleaned.append(
                            {
                                "node": target.get("node"),
                                "type": target.get("type"),
                                "index": int(target.get("index", 0) or 0),
                            }
                        )
                cleaned.sort(
                    key=lambda d: (str(d.get("node")), str(d.get("type")), int(d.get("index") or 0))
                )
                new_lists.append(cleaned)
            out_norm[str(out_type)] = new_lists
        norm[str(src)] = out_norm
    return norm


def normalize_nodes(nodes: Any, *, ignore_ids_positions: bool) -> Any:
    if not isinstance(nodes, list):
        return nodes
    mapped: List[JSONDict] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        copy = dict(node)
        if ignore_ids_positions:
            copy.pop("id", None)
            copy.pop("position", None)
        mapped.append(copy)
    mapped.sort(key=lambda d: str(d.get("name")))
    return mapped


def normalize_workflow(wf: Any, *, relaxed: bool) -> Any:
    if not isinstance(wf, dict):
        return wf
    norm = dict(wf)
    norm["nodes"] = normalize_nodes(norm.get("nodes"), ignore_ids_positions=relaxed)
    norm["connections"] = normalize_connections(norm.get("connections"))
    return norm


def workflow_node_names(wf: Any) -> List[str]:
    if not isinstance(wf, dict):
        return []
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        return []
    out: List[str] = []
    for node in nodes:
        if isinstance(node, dict) and node.get("name"):
            out.append(str(node["name"]))
    return out


def workflow_has_dangling_connections(wf: Any) -> bool:
    if not isinstance(wf, dict):
        return True
    names = set(workflow_node_names(wf))
    conns = wf.get("connections")
    if conns is None or not isinstance(conns, dict):
        return True
    for src, outputs in conns.items():
        if str(src) not in names:
            return True
        if not isinstance(outputs, dict):
            continue
        for _out_type, out_lists in outputs.items():
            if not isinstance(out_lists, list):
                continue
            for targets in out_lists:
                if not isinstance(targets, list):
                    continue
                for target in targets:
                    if isinstance(target, dict) and target.get("node") and str(target["node"]) not in names:
                        return True
    return False
