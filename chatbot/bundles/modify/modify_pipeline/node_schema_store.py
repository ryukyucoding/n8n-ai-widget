"""
Load n8n node JSON schemas from the shared ``chatbot/schemas`` export (same roots as insert).

Used by the modify pipeline so the LLM can map UI labels to exact ``options[].value`` strings.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

JSONDict = Dict[str, Any]

# modify_pipeline → modify → bundles → chatbot
_CHATBOT_ROOT = Path(__file__).resolve().parent.parent.parent.parent


def default_schema_roots() -> List[Path]:
    for key in ("N8N_WIDGET_SCHEMA_ROOT", "WIDGET_NODE_SCHEMA_ROOT"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            base = Path(raw)
            return [base / "node_schemas", base / "core_nodes_schemas"]
    base = _CHATBOT_ROOT / "schemas"
    return [base / "node_schemas", base / "core_nodes_schemas"]


class NodeSchemaStore:
    """Same indexing rules as insert's ``NodeSchemaStore``; shared ``chatbot/schemas`` roots."""

    def __init__(self, roots: Optional[Iterable[Path]] = None) -> None:
        self.roots = list(roots) if roots else default_schema_roots()
        self._type_to_path: Dict[str, Path] = {}
        self._scache: Dict[str, JSONDict] = {}
        self._rebuild_index()

    def _rebuild_index(self) -> None:
        self._type_to_path.clear()
        for root in self.roots:
            if not root.is_dir():
                continue
            for p in root.glob("*.json"):
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                except Exception:
                    continue
                name = data.get("name")
                if isinstance(name, str) and name and name not in self._type_to_path:
                    self._type_to_path[name] = p

    def resolve_path(self, node_type: str) -> Optional[Path]:
        return self._type_to_path.get(node_type)

    def load_schema(self, node_type: str) -> Optional[JSONDict]:
        if node_type in self._scache:
            return self._scache[node_type]
        p = self.resolve_path(node_type)
        if not p:
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
        if isinstance(data, dict):
            self._scache[node_type] = data
            return data
        return None

    def compact_schema_for_modify(
        self,
        node_type: str,
        *,
        max_properties: int = 120,
        max_options_per_field: int = 200,
        max_chars: int = 48_000,
    ) -> str:
        """Rich option lists so UI phrases map to exact ``value`` tokens (e.g. sendAndWait)."""
        sch = self.load_schema(node_type)
        if not sch:
            return json.dumps({"error": "unknown_node_type", "node_type": node_type}, ensure_ascii=False)
        props_in = sch.get("properties")
        props_out: List[JSONDict] = []
        if isinstance(props_in, list):
            for prop in props_in:
                if not isinstance(prop, dict):
                    continue
                if prop.get("type") == "notice":
                    continue
                slim: JSONDict = {
                    "displayName": prop.get("displayName"),
                    "name": prop.get("name"),
                    "type": prop.get("type"),
                }
                pd = prop.get("description")
                if isinstance(pd, str) and pd.strip():
                    slim["description"] = pd.strip()[:400]
                if "default" in prop:
                    slim["default"] = prop.get("default")
                if prop.get("required"):
                    slim["required"] = True
                opts = prop.get("options")
                if isinstance(opts, list) and opts:
                    slim["options"] = [
                        {"name": o.get("name"), "value": o.get("value")}
                        for o in opts
                        if isinstance(o, dict)
                    ][:max_options_per_field]
                props_out.append(slim)
                if len(props_out) >= max_properties:
                    break
        out: JSONDict = {
            "name": sch.get("name"),
            "displayName": sch.get("displayName"),
            "description": sch.get("description"),
            "defaults": sch.get("defaults"),
            "version": sch.get("version"),
        }
        group = sch.get("group")
        if isinstance(group, list) and group:
            out["group"] = group[:12]
        out["properties"] = props_out
        s = json.dumps(out, ensure_ascii=False, indent=2)
        if len(s) > max_chars:
            return s[:max_chars] + "\n... [truncated]\n"
        return s


_schema_singleton: Optional[NodeSchemaStore] = None


def get_schema_store() -> NodeSchemaStore:
    global _schema_singleton
    if _schema_singleton is None:
        _schema_singleton = NodeSchemaStore()
    return _schema_singleton
