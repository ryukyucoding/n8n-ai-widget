#!/usr/bin/env python3
"""
n8n Workflow Auto-Validation & Real-time Alignment System.
Post-inference pipeline to repair JSON syntax and align node types.
"""

from __future__ import annotations

import difflib
import copy
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from json_repair import repair_json

JSONDict = Dict[str, Any]


SAFE_BENCHMARK_FINDING_CATEGORIES = frozenset({
    "node_type",
    "type_version",
    "parameter_schema",
    "parameter_value",
    "connection_port",
    "connection_shape",
    "code_dataflow",
    "unsupported_metadata",
    "payload_sanitization",
})


class StructuredValidationError(ValueError):
    """A normal validator error with an optional safe benchmark projection."""

    def __init__(self, message: str, findings: List[JSONDict]) -> None:
        super().__init__(message)
        self.safe_findings = findings


def safe_benchmark_finding(
    category: str,
    severity: str = "repair",
    repairable: bool = True,
    normalized: bool = False,
    blocking: Optional[bool] = None,
    repair_context: Optional[JSONDict] = None,
) -> JSONDict:
    """Return the child protocol's fixed, de-identified finding shape."""
    if category not in SAFE_BENCHMARK_FINDING_CATEGORIES:
        raise ValueError("unsupported safe benchmark finding category")
    if severity not in {"warning", "repair", "fail"}:
        raise ValueError("unsupported safe benchmark finding severity")
    finding: JSONDict = {
        "category": category,
        "severity": severity,
        "repairable": bool(repairable),
        "normalized": bool(normalized),
        "blocking": bool(blocking) if blocking is not None else severity != "warning" and not normalized,
    }
    if repair_context is not None:
        allowed = {
            "nodeIndex", "nodeType", "parameterName",
            "sourceNodeIndex", "sourceNodeType", "targetNodeIndex", "targetNodeType",
            "connectionType", "sourceOutputIndex", "targetInputIndex",
        }
        finding["repairContext"] = {
            key: value
            for key, value in repair_context.items()
            if key in allowed and (isinstance(value, str) or isinstance(value, int))
        }
    return finding
# n8n node descriptions can declare a variable number of inputs with a
# declarative expression such as `Array.from({ length: parameters.numberInputs
# || 2 }, ...)`. This recognizes that shared runtime-description pattern; it
# is deliberately based on the description, not on a particular node type.
_DYNAMIC_INPUT_COUNT = re.compile(
    r"Array\.from\(\s*\{\s*length\s*:\s*parameters(?:\.([A-Za-z_]\w*)|\[['\"]([^'\"]+)['\"]\])\s*\|\|\s*(\d+)",
    re.DOTALL,
)
_DYNAMIC_PARAMETER_ASSIGNMENT = re.compile(
    r"const\s+(?P<variable>[A-Za-z_]\w*)\s*=\s*\$parameter(?:\.([A-Za-z_]\w*)|\[['\"]([^'\"]+)['\"]\])\s*;"
)
_DYNAMIC_ARRAY_PORT = re.compile(
    r"!Array\.isArray\(\s*(?P<variable>[A-Za-z_]\w*)\s*\).*?"
    r"return\s*\[\s*\{\s*type\s*:\s*['\"](?P<port>[A-Za-z_]\w*)['\"]",
    re.DOTALL,
)
_DYNAMIC_CONDITIONAL_PORTS = re.compile(
    r"if\s*\(\s*(?P<left_variable>[A-Za-z_]\w*)\s*===\s*['\"](?P<left_value>[^'\"]+)['\"]\s*"
    r"&&\s*(?P<right_variable>[A-Za-z_]\w*)\s*===\s*['\"](?P<right_value>[^'\"]+)['\"]\s*\)\s*"
    r"\{\s*return\s*\[(?P<ports>.*?)\]\s*;\s*\}",
    re.DOTALL,
)
_DYNAMIC_FALLBACK_PORTS = re.compile(r"return\s*\[(?P<ports>[^\]]+)\]\s*;", re.DOTALL)
_PORT_TYPE_LITERAL = re.compile(r"(?:type\s*:\s*)?['\"](?P<port>[A-Za-z_]\w*)['\"]")


def _port_types_from_return(raw_ports: str) -> Optional[List[str]]:
    ports = _PORT_TYPE_LITERAL.findall(raw_ports)
    return ports or None


def _dynamic_array_ports(raw_ports: str, node: JSONDict) -> Optional[List[str]]:
    """Read n8n's explicit single-or-array port pattern without evaluating JS."""
    assignments = {
        match.group("variable"): match.group(2) or match.group(3)
        for match in _DYNAMIC_PARAMETER_ASSIGNMENT.finditer(raw_ports)
    }
    match = _DYNAMIC_ARRAY_PORT.search(raw_ports)
    if not match or match.group("variable") not in assignments:
        return None
    parameter = assignments[match.group("variable")]
    value = node.get("parameters", {}).get(parameter)
    return [match.group("port")] * len(value) if isinstance(value, list) else [match.group("port")]


def _dynamic_conditional_ports(raw_ports: str, node: JSONDict) -> Optional[List[str]]:
    """Read an explicit two-parameter conditional port declaration safely."""
    assignments = {
        match.group("variable"): match.group(2) or match.group(3)
        for match in _DYNAMIC_PARAMETER_ASSIGNMENT.finditer(raw_ports)
    }
    match = _DYNAMIC_CONDITIONAL_PORTS.search(raw_ports)
    if not match:
        return None
    left = assignments.get(match.group("left_variable"))
    right = assignments.get(match.group("right_variable"))
    parameters = node.get("parameters", {})
    if left and right and parameters.get(left) == match.group("left_value") and parameters.get(right) == match.group("right_value"):
        return _port_types_from_return(match.group("ports"))
    fallback_matches = list(_DYNAMIC_FALLBACK_PORTS.finditer(raw_ports))
    if not fallback_matches:
        return None
    return _port_types_from_return(fallback_matches[-1].group("ports"))

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


class RuntimeSchemaStore:
    """Reads descriptions exported by the *running* n8n container."""

    def __init__(self) -> None:
        default = Path(__file__).resolve().parent.parent / "schemas" / "runtime_node_schemas.json"
        self.path = Path(os.environ.get("N8N_RUNTIME_SCHEMA_PATH", default))
        self.schemas: Dict[str, Any] = {}
        if self.path.is_file():
            try:
                self.schemas = json.loads(self.path.read_text(encoding="utf-8")).get("nodeTypes", {})
            except (OSError, json.JSONDecodeError) as error:
                raise RuntimeError(f"unable to read runtime node schema export: {error}") from error

    def description_for(self, node_type: str, version: float) -> Optional[JSONDict]:
        node = self.schemas.get(node_type)
        if not isinstance(node, dict):
            return None
        versions = node.get("versions", {})
        if not isinstance(versions, dict):
            return None
        for raw_version, description in versions.items():
            try:
                if float(raw_version) == float(version) and isinstance(description, dict):
                    return description
            except (TypeError, ValueError):
                continue
        return None

    def available_versions(self, node_type: str) -> List[str]:
        node = self.schemas.get(node_type)
        versions = node.get("versions", {}) if isinstance(node, dict) else {}
        if not isinstance(versions, dict):
            return []
        return sorted(versions.keys(), key=lambda value: float(value))

    def classify_named_types(self, request: str) -> Tuple[Set[str], Set[str]]:
        """Classify explicitly named runtime nodes as required or forbidden.

        Matching is clause-based: a negative phrase applies to every node name
        in its punctuation-delimited clause, so "do not use Webhook or
        Schedule" forbids both nodes without any node-specific exception.
        Names without clear intent are not requirements.
        """
        required: Set[str] = set()
        forbidden: Set[str] = set()
        clauses = re.split(r"[,，。;；\n]+", request)
        positive_intent = re.compile(
            r"(?:使用|包含|加入|採用|需要|必須|use|include|with|add|require|must)",
            re.IGNORECASE,
        )
        negative_intent = re.compile(
            r"(?:不要|不得|禁止|不可|不包含|排除|不使用|do\s+not|don['’]t|without|exclude|forbid)",
            re.IGNORECASE,
        )
        for node_type, node in self.schemas.items():
            versions = node.get("versions", {}) if isinstance(node, dict) else {}
            for description in versions.values() if isinstance(versions, dict) else []:
                display_name = description.get("displayName") if isinstance(description, dict) else None
                if not isinstance(display_name, str) or len(display_name.strip()) < 3:
                    continue
                name_pattern = re.compile(
                    rf"(?<![A-Za-z0-9]){re.escape(display_name)}(?![A-Za-z0-9])",
                    re.IGNORECASE,
                )
                matching_clauses = [clause for clause in clauses if name_pattern.search(clause)]
                if any(negative_intent.search(clause) for clause in matching_clauses):
                    forbidden.add(node_type)
                elif any(positive_intent.search(clause) for clause in matching_clauses):
                    required.add(node_type)
                if matching_clauses:
                    break
        return required, forbidden

    def explicitly_named_types(self, request: str) -> Set[str]:
        """Backward-compatible required-node view of ``classify_named_types``."""
        required, _ = self.classify_named_types(request)
        return required

    def input_ports_for(self, node: JSONDict) -> Optional[List[str]]:
        """Return target input connection types when runtime metadata exposes them.

        ``None`` means that a node has an input expression we cannot safely
        resolve. In that case we retain the structural checks but do not invent
        a port count. Static descriptions and n8n's common Array.from dynamic
        input declaration are both resolved from the installed runtime schema.
        """
        description = self.description_for(node["type"], node["typeVersion"])
        if not description:
            return None

        raw_inputs = description.get("inputs")
        if isinstance(raw_inputs, list):
            ports: List[str] = []
            for item in raw_inputs:
                if isinstance(item, str):
                    ports.append(item)
                elif isinstance(item, dict) and isinstance(item.get("type"), str):
                    ports.append(item["type"])
                else:
                    return None
            return ports

        if not isinstance(raw_inputs, str):
            return None
        match = _DYNAMIC_INPUT_COUNT.search(raw_inputs)
        if match:
            parameter_name = match.group(1) or match.group(2)
            default_count = int(match.group(3))
            raw_count = node.get("parameters", {}).get(parameter_name, default_count)
            if isinstance(raw_count, bool) or not isinstance(raw_count, int) or raw_count < 0:
                return None
            # The recognized n8n pattern creates one main input object per item.
            return ["main"] * raw_count
        return _dynamic_conditional_ports(raw_inputs, node)

    def output_ports_for(self, node: JSONDict) -> Optional[List[str]]:
        """Return source output connection types for static runtime definitions."""
        description = self.description_for(node["type"], node["typeVersion"])
        if not description:
            return None
        raw_outputs = description.get("outputs")
        if isinstance(raw_outputs, str):
            return _dynamic_array_ports(raw_outputs, node)
        if not isinstance(raw_outputs, list):
            return None
        ports: List[str] = []
        for item in raw_outputs:
            if isinstance(item, str):
                ports.append(item)
            elif isinstance(item, dict) and isinstance(item.get("type"), str):
                ports.append(item["type"])
            else:
                return None
        return ports


def _is_expression(value: Any) -> bool:
    return isinstance(value, str) and value.lstrip().startswith("=")


def _matches_display_value(actual: Any, expected: Any) -> bool:
    """Evaluate n8n displayOptions values, including version comparators."""
    if not isinstance(expected, dict):
        return actual == expected
    condition = expected.get("_cnd")
    if not isinstance(condition, dict):
        return False
    for operator, operand in condition.items():
        try:
            if operator == "eq" and actual != operand:
                return False
            if operator == "neq" and actual == operand:
                return False
            if operator == "gt" and not actual > operand:
                return False
            if operator == "gte" and not actual >= operand:
                return False
            if operator == "lt" and not actual < operand:
                return False
            if operator == "lte" and not actual <= operand:
                return False
            if operator not in {"eq", "neq", "gt", "gte", "lt", "lte"}:
                return False
        except TypeError:
            return False
    return True


def _is_applicable(property_def: JSONDict, parameters: JSONDict, version: float) -> bool:
    display = property_def.get("displayOptions", {})
    if not isinstance(display, dict):
        return True
    for mode, expected in (("show", True), ("hide", False)):
        rules = display.get(mode, {})
        if not isinstance(rules, dict):
            continue
        matches = True
        for key, allowed in rules.items():
            actual = version if key == "@version" else parameters.get(key)
            allowed_values = allowed if isinstance(allowed, list) else [allowed]
            if not any(_matches_display_value(actual, value) for value in allowed_values):
                matches = False
                break
        if matches:
            return expected
    return True


def _validate_value(value: Any, definition: JSONDict, path: str) -> Optional[str]:
    if _is_expression(value):
        return None
    kind = definition.get("type")
    if kind == "boolean" and not isinstance(value, bool):
        return f"{path} must be boolean"
    if kind == "number" and (isinstance(value, bool) or not isinstance(value, (int, float))):
        return f"{path} must be numeric"
    if kind in {"string", "options", "json"} and not isinstance(value, str):
        return f"{path} must be a string"
    if kind == "multiOptions" and not isinstance(value, list):
        return f"{path} must be an array"
    if kind == "options" and isinstance(value, str):
        choices = {item.get("value") for item in definition.get("options", []) if isinstance(item, dict)}
        if choices and value not in choices:
            return f"{path} has unsupported value {value!r}; allowed values: {', '.join(map(str, sorted(choices)))}"
    if kind == "fixedCollection" and not isinstance(value, dict):
        return f"{path} must be an object"
    return None


def validate_node_parameters(
    workflow_dict: JSONDict,
    user_request: str = "",
    include_repair_context: bool = False,
) -> None:
    """Validate every generated parameter against runtime-exported n8n descriptions."""
    store = RuntimeSchemaStore()
    if not store.schemas:
        if os.environ.get("N8N_RUNTIME_SCHEMA_REQUIRED", "true").lower() in {"1", "true", "yes"}:
            raise ValueError("runtime node schema export is missing; cannot safely validate parameters")
        print("[workflow-repair] runtime schema export unavailable; parameter validation skipped", file=sys.stderr)
        return

    errors: List[str] = []
    safe_findings: List[JSONDict] = []
    required_types, forbidden_types = store.classify_named_types(user_request) if user_request else (set(), set())
    generated_types = {node["type"] for node in workflow_dict["nodes"]}
    for node_type in sorted(required_types - generated_types):
        errors.append(
            f"original user request requires runtime node {node_type}; "
            "the workflow must include that exact type"
        )
        safe_findings.append(safe_benchmark_finding("node_type", "repair", True, False, True))
    for node_type in sorted(forbidden_types & generated_types):
        errors.append(
            f"original user request forbids runtime node {node_type}; "
            "the workflow must not include that type"
        )
        safe_findings.append(safe_benchmark_finding("node_type", "repair", True, False, True))
    for node_index, node in enumerate(workflow_dict["nodes"]):
        description = store.description_for(node["type"], node["typeVersion"])
        if not description:
            versions = ", ".join(store.available_versions(node["type"])) or "none"
            errors.append(
                f"node {node['name']!r} has no runtime schema for typeVersion "
                f"{node['typeVersion']}; available versions: {versions}"
            )
            safe_findings.append(safe_benchmark_finding("type_version", "repair", True, False, True))
            continue
        parameters = node["parameters"]
        # n8n hides many fields behind displayOptions (for example Code.jsCode
        # depends on the default language). Evaluate those conditions against
        # the same defaults n8n applies when an option is omitted.
        effective_parameters: JSONDict = {
            definition["name"]: definition["default"]
            for definition in description.get("properties", [])
            if isinstance(definition, dict)
            and isinstance(definition.get("name"), str)
            and "default" in definition
        }
        effective_parameters.update(parameters)
        definitions: Dict[str, List[JSONDict]] = {}
        for definition in description.get("properties", []):
            if isinstance(definition, dict) and _is_applicable(definition, effective_parameters, node["typeVersion"]):
                definitions.setdefault(definition.get("name"), []).append(definition)
        for name, value in parameters.items():
            candidates = definitions.get(name, [])
            if not candidates:
                valid_names = ", ".join(sorted(key for key in definitions if isinstance(key, str)))
                errors.append(
                    f"node {node['name']!r}: parameters.{name} is not valid for this node version; "
                    f"valid parameters: {valid_names}"
                )
                repair_context = (
                    {"nodeIndex": node_index, "nodeType": node["type"], "parameterName": name}
                    if include_repair_context
                    else None
                )
                safe_findings.append(
                    safe_benchmark_finding(
                        "parameter_schema", "repair", True, False, True, repair_context
                    )
                )
                continue
            candidate_errors = [_validate_value(value, definition, f"parameters.{name}") for definition in candidates]
            if all(error is not None for error in candidate_errors):
                errors.append(f"node {node['name']!r}: {candidate_errors[0]}")
                safe_findings.append(safe_benchmark_finding("parameter_value", "repair", True, False, True))
    if errors:
        raise StructuredValidationError("workflow parameter validation failed: " + "; ".join(errors), safe_findings)


def validate_connection_ports(
    workflow_dict: JSONDict,
    include_repair_context: bool = False,
) -> List[JSONDict]:
    """Normalize unambiguous source/target ports, then validate connections.

    n8n accepts some malformed workflow JSON even when the canvas cannot draw
    it on a visible input socket. Catching it here keeps invalid workflows out
    of the create API and turns the failure into precise retry feedback. Port
    repair is only allowed when the runtime schema proves one compatible port.
    """
    store = RuntimeSchemaStore()
    if not store.schemas:
        return []

    nodes_by_name = {node["name"]: node for node in workflow_dict["nodes"]}
    node_indices = {node["name"]: index for index, node in enumerate(workflow_dict["nodes"])}
    errors: List[str] = []
    error_contexts: List[JSONDict] = []
    normalizations: List[JSONDict] = []

    def add_error(message: str, source_name: str, connection_type: str,
                  output_index: int, target: Optional[JSONDict] = None,
                  target_index: Optional[int] = None) -> None:
        errors.append(message)
        if not include_repair_context:
            error_contexts.append({})
            return
        source = nodes_by_name[source_name]
        context: JSONDict = {
            "sourceNodeIndex": node_indices[source_name],
            "sourceNodeType": source["type"],
            "connectionType": connection_type,
            "sourceOutputIndex": output_index,
        }
        if target is not None and target_index is not None:
            context.update({
                "targetNodeIndex": node_indices[target["name"]],
                "targetNodeType": target["type"],
                "targetInputIndex": target_index,
            })
        error_contexts.append(context)

    for source_name, output_types in workflow_dict.get("connections", {}).items():
        source = nodes_by_name[source_name]
        source_ports = store.output_ports_for(source)
        for connection_type, groups in output_types.items():
            source_compatible_indices = [] if source_ports is None else [
                index for index, port_type in enumerate(source_ports)
                if port_type == connection_type
            ]
            for output_index, group in enumerate(groups):
                if source_ports is None:
                    add_error(
                        f"connection from {source_name!r} cannot confirm source output ports from "
                        "the runtime schema; refusing to guess an output index",
                        source_name, connection_type, output_index,
                    )
                elif output_index not in source_compatible_indices:
                    # The source output index is represented by the connection
                    # group position. Move it only when the runtime schema
                    # proves a unique compatible output for this type.
                    if len(source_compatible_indices) == 1:
                        normalized_index = source_compatible_indices[0]
                        if normalized_index >= len(groups):
                            groups.extend([] for _ in range(normalized_index - len(groups) + 1))
                        if output_index != normalized_index:
                            groups[normalized_index].extend(group)
                            groups[output_index] = []
                            normalizations.append({
                                "kind": "connection_source_port_normalized",
                                "sourceNode": source_name,
                                "connectionType": connection_type,
                                "fromOutputIndex": output_index,
                                "toOutputIndex": normalized_index,
                                "reason": "runtime schema exposes one compatible source output",
                            })
                    elif output_index >= len(source_ports):
                        add_error(
                            f"node {source_name!r} has no output port {output_index} for connection type {connection_type!r}",
                            source_name, connection_type, output_index,
                        )
                    else:
                        add_error(
                            f"node {source_name!r} output port {output_index} has type "
                            f"{source_ports[output_index]!r}, not {connection_type!r}",
                            source_name, connection_type, output_index,
                        )

                # Continue checking target ports even when a source-port
                # finding exists. This collects all independently decidable
                # connection findings into one regeneration request.
                for connection in group:
                    target = nodes_by_name[connection["node"]]
                    target_ports = store.input_ports_for(target)
                    if target_ports is None:
                        add_error(
                            f"connection from {source_name!r} to {target['name']!r} cannot confirm "
                            "target input ports from the runtime schema; refusing to guess an input index",
                            source_name, connection_type, output_index, target, connection.get("index", 0),
                        )
                        continue
                    target_index = connection["index"]
                    compatible_indices = [
                        index for index, port_type in enumerate(target_ports)
                        if port_type == connection_type
                    ]
                    target_index_is_valid = (
                        target_index < len(target_ports)
                        and target_ports[target_index] == connection_type
                    )
                    # A target index is safe to repair only when the installed
                    # runtime description proves one compatible input. Nodes
                    # with multiple compatible inputs remain invalid rather
                    # than being guessed at.
                    if not target_index_is_valid and len(compatible_indices) == 1:
                        normalized_index = compatible_indices[0]
                        connection["index"] = normalized_index
                        normalizations.append({
                            "kind": "connection_target_port_normalized",
                            "sourceNode": source_name,
                            "targetNode": target["name"],
                            "connectionType": connection_type,
                            "fromIndex": target_index,
                            "toIndex": normalized_index,
                            "reason": "runtime schema exposes one compatible target input",
                        })
                        continue
                    if target_index >= len(target_ports):
                        valid_indices = ", ".join(str(index) for index in range(len(target_ports))) or "none"
                        add_error(
                            f"connection from {source_name!r} to {target['name']!r} uses input index "
                            f"{target_index}, but this node version exposes input indices: {valid_indices}",
                            source_name, connection_type, output_index, target, target_index,
                        )
                        continue
                    if target_ports[target_index] != connection_type:
                        add_error(
                            f"connection from {source_name!r} to {target['name']!r} uses type "
                            f"{connection_type!r}, but input index {target_index} expects "
                            f"{target_ports[target_index]!r}",
                            source_name, connection_type, output_index, target, target_index,
                        )
            # Preserve valid empty branches, but remove only empty groups beyond
            # the runtime's output range after a source-port normalization.
            if source_ports is not None:
                while len(groups) > len(source_ports) and not groups[-1]:
                    groups.pop()
    protocol_findings = [
        safe_benchmark_finding("connection_port", "warning", False, True, False)
        for _ in normalizations
    ]
    protocol_findings.extend(
        safe_benchmark_finding("connection_port", "repair", True, False, True, context or None)
        for context in error_contexts
    )
    if errors:
        raise StructuredValidationError("workflow connection-port validation failed: " + "; ".join(errors), protocol_findings)
    return normalizations

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
        raw_namespace = raw_type.rsplit(".", 1)[0] if "." in raw_type else ""
        normalized_raw = raw_segment.lower().replace("-", "").replace("_", "")
        candidates = []
        for valid_type in sorted(self.valid_types):
            valid_namespace = valid_type.rsplit(".", 1)[0] if "." in valid_type else ""
            # A missing base-node entry must never be changed into a LangChain
            # node just because both types end in "code" (or another common name).
            if raw_namespace and valid_namespace != raw_namespace:
                continue
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
            # Generated JSON sometimes carries editor/validator annotations
            # beside a node. They are not part of n8n's workflow contract and
            # the update path already strips them with the same allowlist.
            # Retain only known runtime fields instead of wasting a model retry
            # on harmless presentation metadata.
            for field in extra_fields:
                node.pop(field, None)
            print(
                f"[workflow-repair] stripped unsupported node metadata from {label}: "
                f"{', '.join(extra_fields)}",
                file=sys.stderr,
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


def normalize_node_positions(workflow_dict: JSONDict) -> None:
    """Keep generated nodes readable when branch positions are too close."""
    occupied: List[tuple[float, float]] = []
    for node in workflow_dict["nodes"]:
        x, y = node["position"]
        candidate = (x, y)
        # n8n cards are wider/taller than their connection point. Keep a
        # compact 140 px vertical gap within the same visual column.
        while True:
            conflicts = [
                existing_y
                for existing_x, existing_y in occupied
                if abs(candidate[0] - existing_x) < 180
                and abs(candidate[1] - existing_y) < 140
            ]
            if not conflicts:
                break
            candidate = (x, max(conflicts) + 140)
        if candidate != (x, y):
            node["position"] = [candidate[0], candidate[1]]
        occupied.append(candidate)


def canonicalize_workflow(
    raw_output: str,
    n8n_url: Optional[str] = None,
    api_key: Optional[str] = None,
    user_request: str = "",
) -> JSONDict:
    """Parse and align a workflow before any runtime validation or execution."""
    # 1. Repair and load JSON
    workflow_data = heal_json_format(raw_output)

    # 2. Normalize the common n8n workflow contract before node-type alignment.
    workflow_data = normalize_workflow_structure(workflow_data)

    # 3. Combine the n8n API registry with the descriptions exported from the
    # running n8n container. The latter is authoritative for installed types
    # when the public node-type endpoint omits a built-in node.
    runtime_schema_store = RuntimeSchemaStore()
    registry = N8nRegistryFetcher(n8n_url, api_key)
    valid_types = registry.fetch_latest_node_types()
    valid_types.update(runtime_schema_store.schemas.keys())
    if not valid_types:
        raise RuntimeError("unable to load a trusted n8n node-type registry")

    # 4. Align nodes
    aligner = FuzzyNodeAligner(valid_types)
    return aligner.heal_workflow_nodes(workflow_data)


def process_and_verify_workflow(
    raw_output: str,
    n8n_url: Optional[str] = None,
    api_key: Optional[str] = None,
    user_request: str = "",
    return_metadata: bool = False,
) -> Any:
    """Main entrypoint: canonicalizes, validates, and normalizes a workflow."""
    healed_workflow = canonicalize_workflow(raw_output, n8n_url, api_key, user_request)

    # 5. Reject invalid node options before the workflow is sent to n8n.
    validate_node_parameters(healed_workflow, user_request)

    # 6. Reject connections that point outside the input ports exposed by the
    # installed n8n node version. This also covers common dynamic port counts.
    connection_port_repairs = validate_connection_ports(healed_workflow)

    # 7. Separate coincident branch nodes without changing workflow behavior.
    normalize_node_positions(healed_workflow)

    if return_metadata:
        return healed_workflow, connection_port_repairs
    return healed_workflow


def _benchmark_protocol_envelope(
    ok: bool,
    findings: List[JSONDict],
    unstructured_failure: bool,
) -> JSONDict:
    """The benchmark-only child contract: no workflow or error text."""
    return {
        "ok": bool(ok),
        "findings": findings,
        "unstructuredFailure": bool(unstructured_failure),
    }


def _connection_port_protocol_findings(repairs: List[JSONDict]) -> List[JSONDict]:
    return [
        safe_benchmark_finding("connection_port", "warning", False, True, False)
        for _ in repairs
    ]


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"ok": False, "error": "empty stdin"}))
        sys.exit(1)

    try:
        envelope = json.loads(raw)
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"invalid envelope JSON: {error}"}))
        sys.exit(1)

    benchmark_static_protocol = envelope.get("benchmarkStaticProtocol") is True
    raw_output = envelope.get("raw_output") or ""
    n8n_url = envelope.get("n8n_url")
    api_key = envelope.get("api_key")
    user_request = envelope.get("user_request") or ""

    if not raw_output:
        if benchmark_static_protocol:
            print(json.dumps(_benchmark_protocol_envelope(False, [], True)))
        else:
            print(json.dumps({"ok": False, "error": "raw_output is required"}))
        sys.exit(1)

    try:
        healed, connection_port_repairs = process_and_verify_workflow(
            raw_output,
            n8n_url,
            api_key,
            user_request,
            return_metadata=True,
        )
        if benchmark_static_protocol:
            print(json.dumps(_benchmark_protocol_envelope(
                True,
                _connection_port_protocol_findings(connection_port_repairs),
                False,
            ), ensure_ascii=False))
            return

        warnings = []
        for repair in connection_port_repairs:
            if repair.get("kind") == "connection_source_port_normalized":
                warnings.append(
                    "Normalized connection source output port from "
                    f"{repair['fromOutputIndex']} to {repair['toOutputIndex']} for {repair['sourceNode']} "
                    "because the runtime schema exposes one compatible output."
                )
            else:
                warnings.append(
                    "Normalized connection target input port from "
                    f"{repair['fromIndex']} to {repair['toIndex']} for {repair['targetNode']} "
                    "because the runtime schema exposes one compatible input."
                )
        print(json.dumps({
            "ok": True,
            "workflow": healed,
            "warnings": warnings,
            "repairs": {"connectionPorts": connection_port_repairs},
        }, ensure_ascii=False))
    except StructuredValidationError as error:
        if benchmark_static_protocol:
            findings = list(error.safe_findings)
            print(json.dumps(_benchmark_protocol_envelope(False, findings, not findings), ensure_ascii=False))
        else:
            print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)
    except Exception as error:
        if benchmark_static_protocol:
            print(json.dumps(_benchmark_protocol_envelope(False, [], True)))
        else:
            print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
