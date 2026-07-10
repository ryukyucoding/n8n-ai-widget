#!/usr/bin/env python3
"""
n8n Workflow Auto-Validation & Real-time Alignment System.
Post-inference pipeline to repair JSON syntax and align node types.
"""

from __future__ import annotations

import difflib
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from json_repair import repair_json

JSONDict = Dict[str, Any]


def heal_json_format(raw_output: str) -> dict:
    """
    Repairs JSON format using json-repair.
    Handles physical truncation (missing closing brackets) and missing commas.
    """
    cleaned = raw_output.strip()
    # Strip markdown code fences if present
    if "```json" in cleaned:
        cleaned = cleaned.split("```json")[1].split("```")[0].strip()
    elif "```" in cleaned:
        cleaned = cleaned.split("```")[1].split("```")[0].strip()

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
        """
        valid = set()
        schemas_dir = Path(__file__).resolve().parent.parent / "schemas" / "node_schemas"
        if not schemas_dir.is_dir():
            return valid

        langchain_prefixes = (
            "embeddings", "lmChat", "lm", "textSplitter", "vectorStore",
            "retriever", "tool", "document", "memoryChat", "chain", "memory", "outputParser"
        )

        for p in schemas_dir.glob("*.json"):
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

        # 1. Fuzzy match close string similarity
        matches = difflib.get_close_matches(raw_type, self.valid_types, n=1, cutoff=0.5)
        if matches:
            return matches[0]

        # 2. Suffix match after removing symbols (e.g. google-sheets -> googleSheets)
        normalized_raw = raw_type.lower().replace("-", "").replace("_", "")
        for valid_type in self.valid_types:
            last_segment = valid_type.split(".")[-1].lower()
            if normalized_raw in last_segment or last_segment in normalized_raw:
                return valid_type

        # 3. Fallback to raw type if no match found
        return raw_type

    def heal_workflow_nodes(self, workflow_dict: dict) -> dict:
        """
        Traverses workflow nodes list and repairs type fields.
        """
        if "nodes" not in workflow_dict or not isinstance(workflow_dict["nodes"], list):
            return workflow_dict

        for node in workflow_dict["nodes"]:
            if not isinstance(node, dict):
                continue
            original_type = node.get("type", "")
            if original_type:
                aligned = self.align_type(str(original_type))
                node["type"] = aligned

        return workflow_dict


def process_and_verify_workflow(raw_output: str, n8n_url: Optional[str] = None, api_key: Optional[str] = None) -> dict:
    """
    Main entrypoint: parses, heals JSON, and aligns node types.
    """
    # 1. Repair and load JSON
    workflow_data = heal_json_format(raw_output)

    # 2. Fetch registry
    registry = N8nRegistryFetcher(n8n_url, api_key)
    valid_types = registry.fetch_latest_node_types()

    # 3. Align nodes
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
