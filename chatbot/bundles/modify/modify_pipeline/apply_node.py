from __future__ import annotations

import copy
from typing import Any, Dict

JSONDict = Dict[str, Any]


def apply_modified_node(
    workflow: JSONDict,
    original_node_name: str,
    modified_node: JSONDict,
) -> JSONDict:
    """
    Deep-copy ``workflow`` and replace the node named ``original_node_name`` with
    ``modified_node``, while always keeping the original ``id`` and ``name`` so
    ``connections`` (keyed by name) stay valid.
    """
    wf = copy.deepcopy(workflow)
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("workflow.nodes is not a list")

    for i, n in enumerate(nodes):
        if not isinstance(n, dict) or n.get("name") != original_node_name:
            continue
        keep_id = n.get("id")
        keep_name = n.get("name")
        merged = copy.deepcopy(modified_node)
        merged["name"] = keep_name
        if keep_id is not None:
            merged["id"] = keep_id
        nodes[i] = merged
        return wf

    raise ValueError(f'no node named "{original_node_name}" in workflow.nodes')


def merge_node_parameters(
    workflow: JSONDict,
    node_name: str,
    new_parameters: Dict[str, Any],
) -> JSONDict:
    """Replace only ``parameters`` on a node (replace whole parameters object)."""
    wf = copy.deepcopy(workflow)
    nodes = wf.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("workflow.nodes is not a list")
    for n in nodes:
        if isinstance(n, dict) and n.get("name") == node_name:
            n["parameters"] = copy.deepcopy(new_parameters)
            return wf
    raise ValueError(f'no node named "{node_name}"')
