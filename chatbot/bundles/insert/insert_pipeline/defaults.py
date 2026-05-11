from __future__ import annotations

from typing import Any, Dict, MutableMapping, Optional

JSONDict = Dict[str, Any]


def _walk_properties(properties: Any, out: MutableMapping[str, Any]) -> None:
    if not isinstance(properties, list):
        return
    for prop in properties:
        if not isinstance(prop, dict):
            continue
        if prop.get("type") == "notice":
            continue
        name = prop.get("name")
        typ = prop.get("type")
        if typ in ("collection", "fixedCollection"):
            continue
        if isinstance(name, str) and name and "default" in prop:
            out[name] = prop.get("default")


def parameter_defaults_from_schema(schema: Optional[JSONDict]) -> JSONDict:
    """Shallow defaults from n8n node schema ``properties`` (best-effort)."""
    if not schema or not isinstance(schema.get("properties"), list):
        return {}
    out: JSONDict = {}
    _walk_properties(schema["properties"], out)
    return out


def deep_merge_parameters(base: JSONDict, override: JSONDict) -> JSONDict:
    """Recursively merge dicts; values from ``override`` win. Non-dict values replace."""
    out = dict(base)
    for k, v in override.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = deep_merge_parameters(out[k], v)
        else:
            out[k] = v
    return out


def merge_parameters_with_defaults(user_params: JSONDict, defaults: JSONDict) -> JSONDict:
    """Schema defaults first; user / model parameters override (shallow at top level only)."""
    return {**defaults, **user_params}
