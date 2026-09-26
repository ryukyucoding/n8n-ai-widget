#!/usr/bin/env python3
"""Parse workflow JSON from model text; repair minor syntax issues when needed."""

from __future__ import annotations

import json
import sys


def parse_workflow_text(text: str, *, allow_repair: bool = True) -> tuple[dict | None, str | None, bool]:
    """Return (workflow, note, strict_ok). strict_ok=True only when std json.loads succeeds."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[-1]
        if t.endswith("```"):
            t = t.rsplit("```", 1)[0]
        t = t.strip()

    try:
        obj = json.loads(t)
        if isinstance(obj, dict):
            return obj, None, True
    except json.JSONDecodeError:
        pass

    start = t.find("{")
    if start >= 0:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(t)):
            ch = t[i]
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
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(t[start : i + 1])
                        if isinstance(obj, dict):
                            return obj, None, True
                    except json.JSONDecodeError:
                        break

    if not allow_repair:
        return None, "truncated_or_invalid", False

    try:
        from json_repair import repair_json

        fixed = repair_json(t)
        obj = json.loads(fixed)
        if isinstance(obj, dict):
            return obj, "json_repair", False
    except Exception as e:
        return None, str(e), False

    return None, "unparseable", False


if __name__ == "__main__":
    allow_repair = "--strict" not in sys.argv
    text = sys.stdin.read()
    obj, note, strict = parse_workflow_text(text, allow_repair=allow_repair)
    out = {"ok": obj is not None, "workflow": obj, "parse_note": note, "strict": strict}
    print(json.dumps(out, ensure_ascii=False))
