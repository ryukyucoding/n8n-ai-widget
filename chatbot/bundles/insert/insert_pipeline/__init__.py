"""
Two-phase n8n INSERT helper: node catalog + authoritative schema → small LLM JSON → programmatic merge.

``NodeSchemaStore`` reads JSON from ``<chatbot>/schemas/node_schemas`` and
``<chatbot>/schemas/core_nodes_schemas`` (override with ``N8N_WIDGET_SCHEMA_ROOT``).
"""

from __future__ import annotations

from .agent_tool_coercion import coerce_to_langchain_tool_node_type, instruction_requests_langchain_agent_tool
from .defaults import (
    deep_merge_parameters,
    merge_parameters_with_defaults,
    parameter_defaults_from_schema,
)
from .heuristic_tool_location import apply_langchain_tool_location_heuristic
from .instruction_parse import (
    extract_template_workflow,
    infer_openai_node_parameters_from_instruction,
    parse_insert_instruction,
)
from .merge import apply_insert_splice, splice_location_resolvable
from .schema_store import NodeSchemaStore
from .splice_position import (
    build_phase0_splice_messages,
    default_phase0_splice_system_prompt,
    format_template_main_graph_for_llm,
    location_is_resolvable_on_template,
    parse_phase0_splice_json,
)
from .two_phase import (
    build_neighbor_context,
    build_phase1_messages,
    build_phase2_messages,
    default_phase1_system_prompt,
    default_phase2_system_prompt,
    default_phase2_system_prompt_workflow_oracle,
    parse_phase1_json,
    parse_phase2_json,
)

__all__ = [
    "NodeSchemaStore",
    "parse_insert_instruction",
    "infer_openai_node_parameters_from_instruction",
    "instruction_requests_langchain_agent_tool",
    "coerce_to_langchain_tool_node_type",
    "extract_template_workflow",
    "parameter_defaults_from_schema",
    "deep_merge_parameters",
    "merge_parameters_with_defaults",
    "apply_langchain_tool_location_heuristic",
    "apply_insert_splice",
    "splice_location_resolvable",
    "build_phase0_splice_messages",
    "default_phase0_splice_system_prompt",
    "format_template_main_graph_for_llm",
    "location_is_resolvable_on_template",
    "parse_phase0_splice_json",
    "build_neighbor_context",
    "build_phase1_messages",
    "build_phase2_messages",
    "default_phase1_system_prompt",
    "default_phase2_system_prompt",
    "default_phase2_system_prompt_workflow_oracle",
    "parse_phase1_json",
    "parse_phase2_json",
]
