from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

JSONDict = Dict[str, Any]

PACKAGE_DIR = Path(__file__).resolve().parent
# insert_pipeline → bundles/insert → bundles → chatbot
_CHATBOT_ROOT = PACKAGE_DIR.parent.parent.parent


def default_schema_roots() -> List[Path]:
    """
    Shared JSON exports used by insert + modify pipelines.

    Override with ``N8N_WIDGET_SCHEMA_ROOT`` or ``WIDGET_NODE_SCHEMA_ROOT`` (directory that
    contains ``node_schemas/`` and ``core_nodes_schemas/``). Default: ``<chatbot>/schemas/``.
    """
    for key in ("N8N_WIDGET_SCHEMA_ROOT", "WIDGET_NODE_SCHEMA_ROOT"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            base = Path(raw)
            return [base / "node_schemas", base / "core_nodes_schemas"]
    base = _CHATBOT_ROOT / "schemas"
    return [base / "node_schemas", base / "core_nodes_schemas"]


class NodeSchemaStore:
    """
    Maps n8n node ``type`` strings (e.g. n8n-nodes-base.webhook) to JSON schema files.

    Official-style descriptors live under each file's top-level ``name``,
    ``displayName``, and ``description`` (same shape as your ``node_schemas/*.json``).
    """

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

    def iter_catalog_rows(self) -> List[Tuple[str, str, str]]:
        """Each row: ``(type, displayName, description)`` from the resolved schema file."""
        rows: List[Tuple[str, str, str]] = []
        for t in sorted(self._type_to_path.keys()):
            sch = self.load_schema(t) or {}
            disp = str(sch.get("displayName") or t)
            desc = str(sch.get("description") or "").strip().replace("\n", " ")
            rows.append((t, disp, desc))
        return rows

    def build_catalog_text(self, max_lines: int = 0, *, max_description_chars: int = 220) -> str:
        """
        Compact brochure for Phase 1: type, human ``displayName``, and node ``description``
        (truncated) so the model can disambiguate similar integrations.
        """
        parts: List[str] = []
        for i, (t, d, desc) in enumerate(self.iter_catalog_rows()):
            if max_lines and i >= max_lines:
                parts.append(f"... ({len(self._type_to_path) - max_lines} more omitted)")
                break
            if desc and max_description_chars > 0:
                if len(desc) > max_description_chars:
                    desc = desc[: max_description_chars - 1].rstrip() + "…"
                parts.append(f"- {t} — {d} — {desc}")
            else:
                parts.append(f"- {t} — {d}")
        return "\n".join(parts)

    def compact_schema_for_llm(
        self,
        node_type: str,
        *,
        max_properties: int = 96,
        max_chars: int = 24_000,
    ) -> str:
        """Strip schema to properties useful for parameter filling (smaller than full file)."""
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
                    ][:120]
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
        # Optional high-signal codex / grouping (when present in node_schemas exports)
        group = sch.get("group")
        if isinstance(group, list) and group:
            out["group"] = group[:12]
        codex = sch.get("codex")
        if isinstance(codex, dict):
            cats = codex.get("categories")
            if isinstance(cats, list) and cats:
                out["categories"] = [str(c) for c in cats[:8]]
        out["properties"] = props_out
        s = json.dumps(out, ensure_ascii=False, indent=2)
        if len(s) > max_chars:
            return s[:max_chars] + "\n... [truncated]\n"
        return s
