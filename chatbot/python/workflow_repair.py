#!/usr/bin/env python3
"""
n8n Workflow Auto-Validation & Real-time Alignment System.
Post-inference pipeline to repair JSON syntax and align node types.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from json_repair import repair_json

JSONDict = Dict[str, Any]

ALLOWED_NODE_FIELDS = {
    "id",
    "name",
    "type",
    "typeVersion",
    "position",
    "parameters",
    "credentials",
    "disabled",
    "notes",
    "notesInFlow",
    "onError",
    "continueOnFail",
    "retryOnFail",
    "maxTries",
    "waitBetweenTries",
    "alwaysOutputData",
    "executeOnce",
    "webhookId",
}


def heal_json_format(raw_output: str) -> dict:
    """
    Repairs JSON format using json-repair.
    Handles physical truncation (missing closing brackets) and missing commas.
    """
    cleaned = raw_output.strip()
    # Strip a markdown fence only when it wraps the entire response. A JSON
    # string may legitimately contain ``` (for example, in an AI Agent prompt).
    fenced_json = re.fullmatch(
        r"\s*```(?:json)?[ \t]*\r?\n(?P<body>.*)\r?\n```\s*",
        cleaned,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if fenced_json:
        cleaned = fenced_json.group("body").strip()

    repaired_string = repair_json(cleaned)
    try:
        data = json.loads(repaired_string)
        if isinstance(data, dict):
            return data
        else:
            raise ValueError("Repaired JSON is not a dictionary (object) structure.")
    except Exception as e:
        raise RuntimeError(f"JSON syntax repair failed: {str(e)}")


class N8nRegistryFetcher:
    def __init__(self, n8n_url: Optional[str], api_key: Optional[str]):
        self.n8n_url = n8n_url.strip().rstrip('/') if n8n_url else None
        self.api_key = api_key
        self.valid_types: Set[str] = set()

    def fetch_latest_node_types(self) -> Set[str]:
        """
        Fetches official and community node types from n8n API.
        Falls back to local schemas scanning on failure.
        """
        if not self.n8n_url or not self.api_key:
            return self.load_local_fallback()

        url = f"{self.n8n_url}/api/v1/node-types"
        req = urllib.request.Request(url)
        req.add_header("X-N8N-API-KEY", self.api_key)

        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))
                self.valid_types = {node["name"] for node in data if isinstance(node, dict) and "name" in node}
                if self.valid_types:
                    return self.valid_types
        except Exception as e:
            # Print fallback notice to stderr
            print(f"[workflow-repair] n8n API pull failed ({e}). Activating local schema fallback.", file=sys.stderr)

        return self.load_local_fallback()

    def load_local_fallback(self) -> Set[str]:
        """
        Scans local schemas directory to build a fallback node types list.
        Reads the exact "name" property from each schema file for 100% accuracy.
        """
        valid = set()
        schemas_dir = Path(__file__).resolve().parent.parent / "schemas" / "node_schemas"
        if not schemas_dir.is_dir():
            return valid

        langchain_prefixes = (
            "embeddings", "lmChat", "lm", "textSplitter", "vectorStore",
            "retriever", "tool", "document", "memoryChat", "chain", "memory", "outputParser", "agent"
        )

        for p in schemas_dir.glob("*.json"):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    content = f.read(150)
                    idx = content.find('"name"')
                    if idx >= 0:
                        start = content.find('"', idx + 6)
                        if start >= 0:
                            end = content.find('"', start + 1)
                            if end >= 0:
                                valid.add(content[start + 1:end])
                                continue
            except Exception:
                pass

            # Fallback heuristic if string parsing fails
            base_name = p.stem
            is_langchain = any(base_name.startswith(pref) for pref in langchain_prefixes)
            if is_langchain:
                valid.add(f"@n8n/n8n-nodes-langchain.{base_name}")
            else:
                valid.add(f"n8n-nodes-base.{base_name}")

        return valid


class FuzzyNodeAligner:
    def __init__(self, valid_types: Set[str]):
        self.valid_types = list(valid_types)

    def align_type(self, raw_type: str) -> str:
        raw_type = raw_type.strip()
        if raw_type in self.valid_types:
            return raw_type

        # Compare only the node's final segment. A loose similarity check on the
        # full namespace can turn an invented node into an unrelated real node.
        raw_segment = raw_type.split(".")[-1]
        normalized_raw = raw_segment.lower().replace("-", "").replace("_", "")
        candidates = []
        for valid_type in sorted(self.valid_types):
            valid_segment = valid_type.split(".")[-1]
            normalized_valid = valid_segment.lower().replace("-", "").replace("_", "")
            if normalized_raw == normalized_valid:
                candidates.append((1.0, valid_type))
            else:
                similarity = difflib.SequenceMatcher(
                    None, normalized_raw, normalized_valid
                ).ratio()
                if similarity >= 0.85:
                    candidates.append((similarity, valid_type))

        if candidates:
            candidates.sort(key=lambda item: (-item[0], item[1]))
            best_score, best_type = candidates[0]
            if len(candidates) == 1 or best_score > candidates[1][0]:
                return best_type

        # Preserve unmatched types so the validation gate can reject them.
        return raw_type

    def heal_workflow_nodes(self, workflow_dict: dict) -> dict:
        """
        Traverses workflow nodes list and repairs type fields, and cleans up invalid properties.
        """
        if "nodes" not in workflow_dict or not isinstance(workflow_dict["nodes"], list):
            return workflow_dict

        for node in workflow_dict["nodes"]:
            if not isinstance(node, dict):
                continue

            # Clean up waitBetweenTries and maxTries if they are null or not numeric
            for k in ["waitBetweenTries", "maxTries"]:
                if k in node:
                    v = node[k]
                    if v is None or (not isinstance(v, (int, float))):
                        node.pop(k, None)

            # Clean up retryOnFail if it is null
            if "retryOnFail" in node and node["retryOnFail"] is None:
                node.pop("retryOnFail", None)

            original_type = str(node["type"])
            aligned = self.align_type(original_type)
            if aligned not in self.valid_types:
                raise ValueError(
                    f"node '{node['name']}' has unsupported n8n type: {original_type}"
                )
            node["type"] = aligned

        return workflow_dict


def normalize_workflow_structure(workflow_dict: dict) -> dict:
    """Apply n8n's common workflow-shape rules without guessing user data."""
    workflow_name = workflow_dict.get("name")
    if not isinstance(workflow_name, str) or not workflow_name.strip():
        raise ValueError("workflow.name must be a non-empty string")

    nodes = workflow_dict.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("workflow.nodes must be an array")

    node_names = set()
    node_errors = []
    for node_index, node in enumerate(nodes, start=1):
        if not isinstance(node, dict):
            node_errors.append(f"node {node_index} must be an object")
            continue

        name = node.get("name")
        label = repr(name) if isinstance(name, str) and name.strip() else f"at index {node_index}"
        if not isinstance(name, str) or not name.strip():
            node_errors.append(f"node {node_index} must have a non-empty name")
        elif name in node_names:
            node_errors.append(f"duplicate workflow node name: {name}")
        else:
            node_names.add(name)

        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id.strip():
            node_errors.append(f"node {label} must have a non-empty id")

        node_type = node.get("type")
        if not isinstance(node_type, str) or not node_type.strip():
            node_errors.append(f"node {label} must have a non-empty type")

        type_version = node.get("typeVersion")
        if isinstance(type_version, bool) or not isinstance(type_version, (int, float)):
            node_errors.append(f"node {label} must have a numeric typeVersion")

        position = node.get("position")
        if (
            not isinstance(position, list)
            or len(position) != 2
            or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in position)
        ):
            node_errors.append(f"node {label} must have position [x, y] with numeric values")

        if not isinstance(node.get("parameters"), dict):
            node_errors.append(f"node {label} must have an object parameters field")

        extra_fields = sorted(set(node) - ALLOWED_NODE_FIELDS)
        if extra_fields:
            node_errors.append(
                f"node {label} has unsupported top-level field(s): "
                f"{', '.join(extra_fields)}; node configuration belongs in parameters"
            )

    if node_errors:
        raise ValueError("workflow node validation failed: " + "; ".join(node_errors))

    # The create-workflow API requires settings, while an empty graph is valid.
    if not isinstance(workflow_dict.get("settings"), dict):
        workflow_dict["settings"] = {"executionOrder": "v1"}

    raw_connections = workflow_dict.get("connections")
    if raw_connections is None:
        workflow_dict["connections"] = {}
        return workflow_dict
    if not isinstance(raw_connections, dict):
        raise ValueError("workflow.connections must be an object")

    normalized_connections = {}
    for source_name, output_types in raw_connections.items():
        if source_name not in node_names:
            raise ValueError(f"connection source node does not exist: {source_name}")
        if not isinstance(output_types, dict):
            raise ValueError(f"connections for {source_name} must be an object")

        normalized_outputs = {}
        for output_type, raw_groups in output_types.items():
            if not isinstance(output_type, str) or not output_type:
                raise ValueError(f"connection output type is invalid for {source_name}")

            # n8n represents each output as an array of target groups. Models
            # commonly omit this outer array, so a flat list is safe to wrap.
            if isinstance(raw_groups, dict):
                groups = [[raw_groups]]
            elif isinstance(raw_groups, list) and not raw_groups:
                groups = []
            elif isinstance(raw_groups, list) and all(isinstance(item, dict) for item in raw_groups):
                groups = [raw_groups]
            elif isinstance(raw_groups, list) and all(isinstance(item, list) for item in raw_groups):
                groups = raw_groups
            else:
                raise ValueError(
                    f"connections.{source_name}.{output_type} must be an array of target arrays"
                )

            normalized_groups = []
            for group in groups:
                normalized_group = []
                for connection in group:
                    if not isinstance(connection, dict):
                        raise ValueError(f"connection from {source_name} must be an object")
                    target_name = connection.get("node")
                    if target_name not in node_names:
                        raise ValueError(
                            f"connection target node does not exist: {target_name}"
                        )
                    connection_type = connection.get("type")
                    if connection_type is None:
                        connection = {**connection, "type": output_type}
                    elif connection_type != output_type:
                        raise ValueError(
                            f"connection type mismatch for {source_name}: "
                            f"expected {output_type}, got {connection_type}"
                        )
                    index = connection.get("index", 0)
                    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
                        raise ValueError(f"connection index is invalid for {source_name}")
                    normalized_group.append(connection)
                normalized_groups.append(normalized_group)
            normalized_outputs[output_type] = normalized_groups
        normalized_connections[source_name] = normalized_outputs

    workflow_dict["connections"] = normalized_connections
    return workflow_dict


def process_and_verify_workflow(raw_output: str, n8n_url: Optional[str] = None, api_key: Optional[str] = None) -> dict:
    """
    Main entrypoint: parses, heals JSON, and aligns node types.
    """
    # 1. Repair and load JSON
    workflow_data = heal_json_format(raw_output)

    # 2. Normalize the common n8n workflow contract before node-type alignment.
    workflow_data = normalize_workflow_structure(workflow_data)

    # 3. Fetch registry
    registry = N8nRegistryFetcher(n8n_url, api_key)
    valid_types = registry.fetch_latest_node_types()
    if not valid_types:
        raise RuntimeError("unable to load a trusted n8n node-type registry")

    # 4. Align nodes
    aligner = FuzzyNodeAligner(valid_types)
    healed_workflow = aligner.heal_workflow_nodes(workflow_data)

    return healed_workflow


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"ok": False, "error": "empty stdin"}))
        sys.exit(1)

    try:
        envelope = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"invalid envelope JSON: {e}"}))
        sys.exit(1)

    raw_output = envelope.get("raw_output") or ""
    n8n_url = envelope.get("n8n_url")
    api_key = envelope.get("api_key")

    if not raw_output:
        print(json.dumps({"ok": False, "error": "raw_output is required"}))
        sys.exit(1)

    try:
        healed = process_and_verify_workflow(raw_output, n8n_url, api_key)
        print(json.dumps({"ok": True, "workflow": healed}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
