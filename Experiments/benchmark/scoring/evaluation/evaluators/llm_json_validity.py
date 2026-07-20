#!/usr/bin/env python3
"""
LLM output JSON validity for creation evaluation.

Scores whether the model output could be parsed as JSON (object or array),
using the stored llm_response and optionally raw_response fallback.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Optional


def llm_output_json_validity_score(generated_data: Dict) -> float:
    """
    Return 1.0 if the generation is valid JSON, else 0.0.

    If llm_response is already a dict/list (typical after a successful parse
    and save), counts as valid. Otherwise tries lenient parsing on string
    llm_response or raw_response (e.g. parse failures still saved with raw text).
    """
    resp = generated_data.get("llm_response")
    if isinstance(resp, dict) or isinstance(resp, list):
        return 1.0
    if isinstance(resp, str) and _text_is_valid_json(resp):
        return 1.0
    raw = generated_data.get("raw_response")
    if isinstance(raw, str) and raw.strip() and _text_is_valid_json(raw):
        return 1.0
    return 0.0


def llm_output_json_validity_metrics(generated_data: Dict) -> Dict[str, float]:
    """Metrics dict merged into per-template evaluation results."""
    return {"llm_output_valid_json": llm_output_json_validity_score(generated_data)}


def _text_is_valid_json(text: str) -> bool:
    return _parse_json_lenient(text) is not None


def _parse_json_lenient(response_content: str) -> Optional[Any]:
    """Align loosely with LLMWorkflowGenerator JSON recovery heuristics."""
    _json_errors = (json.JSONDecodeError, RecursionError)

    try:
        return json.loads(response_content)
    except _json_errors:
        pass

    content = response_content
    if content.strip().startswith("```"):
        lines = content.split("\n")
        content = "\n".join(
            line for line in lines if not line.strip().startswith("```")
        )

    try:
        return json.loads(content)
    except _json_errors:
        pass

    start_obj = content.find("{")
    start_arr = content.find("[")
    if start_obj == -1 and start_arr == -1:
        return None

    if start_arr != -1 and (start_obj == -1 or start_arr < start_obj):
        end = content.rfind("]")
        if end > start_arr:
            try:
                return json.loads(content[start_arr : end + 1])
            except _json_errors:
                pass
        return None

    start = start_obj
    end = content.rfind("}")
    if end > start:
        try:
            return json.loads(content[start : end + 1])
        except _json_errors:
            pass

    for end in range(len(content) - 1, start, -1):
        if content[end] != "}":
            continue
        try:
            return json.loads(content[start : end + 1])
        except _json_errors:
            continue

    json_match = re.search(r"\{.*\}", content, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group())
        except _json_errors:
            return None
    return None
