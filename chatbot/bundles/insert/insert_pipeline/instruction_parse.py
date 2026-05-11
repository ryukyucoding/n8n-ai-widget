from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple, Union

JSONDict = Dict[str, Any]

Seg = Union[str, int]


def extract_template_workflow(input_text: str) -> Optional[JSONDict]:
    marker = "\n\nTemplate:\n"
    if marker not in input_text:
        return None
    tail = input_text.split(marker, 1)[1].strip()
    try:
        obj = json.loads(tail)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _parse_insert_head(input_text: str) -> Tuple[str, str, JSONDict]:
    """
    inserted_node_name, head_before_template, location_meta.
    location_meta: kind in {between, after, before, unknown}
    """
    marker = "\n\nTemplate:\n"
    head = input_text.split(marker, 1)[0] if marker in input_text else input_text
    head_stripped = head.strip()
    m = re.match(r'^Insert the node "([^"]+)"\s+(.+)$', head_stripped, re.DOTALL)
    if not m:
        return "", head_stripped, {}
    name = m.group(1)
    rest = m.group(2).strip()
    first_line = rest.split("\n", 1)[0].strip()
    loc: JSONDict = {"kind": "unknown"}
    mb = re.search(r'between\s+"([^"]+)"\s+and\s+"([^"]+)"', first_line, re.I)
    if mb:
        loc = {"kind": "between", "between": [mb.group(1), mb.group(2)]}
    else:
        ma = re.search(r'after\s+"([^"]+)"', first_line, re.I)
        if ma:
            loc = {"kind": "after", "after": ma.group(1)}
        else:
            mbef = re.search(r'before\s+"([^"]+)"', first_line, re.I)
            if mbef:
                loc = {"kind": "before", "before": mbef.group(1)}
    return name, head_stripped, loc


def extract_declared_node_type(head: str) -> Optional[str]:
    m = re.search(r'of type\s+"([^"]+)"', head, re.I)
    return m.group(1) if m else None


def extract_set_parameters_dict(head: str) -> Optional[JSONDict]:
    m = re.search(r"Set parameters to:\s*(\{.*\})\s*(?:\.|$)", head, re.DOTALL)
    if not m:
        return None
    try:
        v = json.loads(m.group(1))
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def _parse_path_segments(path: str) -> List[Seg]:
    """e.g. ``conditions.number[0].value1`` → ``['conditions','number',0,'value1']``."""
    segs: List[Seg] = []
    s = path.strip()
    while s:
        m = re.match(r"^([A-Za-z_]\w*)(?:\[(\d+)\])?", s)
        if not m:
            break
        segs.append(m.group(1))
        if m.group(2) is not None:
            segs.append(int(m.group(2)))
        s = s[m.end() :]
        if s.startswith("."):
            s = s[1:]
        elif s == "":
            break
        else:
            return []
    return segs


def _assign_path(root: JSONDict, segments: List[Seg], value: Any) -> None:
    if not segments:
        return
    if len(segments) == 1:
        k = segments[0]
        if not isinstance(k, str):
            return
        root[k] = value
        return
    k0, k1 = segments[0], segments[1]
    if not isinstance(k0, str):
        return
    if isinstance(k1, int):
        lst = root.setdefault(k0, [])
        if not isinstance(lst, list):
            lst = []
            root[k0] = lst
        while len(lst) <= k1:
            lst.append({})
        nxt = lst[k1]
        if not isinstance(nxt, dict):
            nxt = {}
            lst[k1] = nxt
        _assign_path(nxt, segments[2:], value)
    else:
        sub = root.setdefault(k0, {})
        if not isinstance(sub, dict):
            sub = {}
            root[k0] = sub
        _assign_path(sub, segments[1:], value)


def _read_double_quoted(s: str) -> Tuple[str, int]:
    """Read a ``\"...\"`` string starting at s[0] == '\"'; return (decoded, index_after_closing)."""
    if not s or s[0] != '"':
        return "", 0
    i = 1
    out: List[str] = []
    while i < len(s):
        c = s[i]
        if c == "\\":
            if i + 1 < len(s):
                out.append(s[i + 1])
                i += 2
            else:
                i += 1
        elif c == '"':
            return "".join(out), i + 1
        else:
            out.append(c)
            i += 1
    return "".join(out), len(s)


def _parse_such_as_value(s: str) -> Tuple[Any, int]:
    """Parse one RHS value; return (value, chars_consumed)."""
    s = s.lstrip()
    if not s:
        return None, 0
    if s[0] == "{":
        depth = 0
        for j, c in enumerate(s):
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(s[: j + 1]), j + 1
                    except Exception:
                        return s[: j + 1], j + 1
        return s, len(s)
    if s[0] == '"':
        txt, k = _read_double_quoted(s)
        return txt, k
    # unquoted token until comma at depth 0 (no comma inside unquoted — rare)
    j = 0
    while j < len(s) and s[j] not in (",", "\n"):
        j += 1
    token = s[:j].strip()
    if token.lower() == "true":
        return True, j
    if token.lower() == "false":
        return False, j
    try:
        if token.isdigit() or (token.startswith("-") and token[1:].isdigit()):
            return int(token), j
    except Exception:
        pass
    return token, j


def extract_set_parameters_such_as(head: str) -> Optional[JSONDict]:
    """
    Parse prose lines like::

        Set parameters such as: mode = \"markdownToHtml\", options.simpleLineBreaks = \"true\". Other ...

    Best-effort; falls back to None if the block is missing or nothing parses.
    """
    m = re.search(
        r"Set parameters such as:\s*(.+?)(?:\.\s*Other parameters\b|\n\nTemplate:|\Z)",
        head,
        re.DOTALL | re.IGNORECASE,
    )
    if not m:
        return None
    blob = m.group(1).strip()
    if blob.endswith("."):
        blob = blob[:-1].strip()
    out: JSONDict = {}
    i = 0
    n = len(blob)
    while i < n:
        while i < n and blob[i].isspace():
            i += 1
        if i >= n:
            break
        rest = blob[i:]
        km = re.match(r"^([A-Za-z_][A-Za-z0-9_.\[\]]*)\s*=\s*", rest)
        if not km:
            break
        key_path = km.group(1)
        after_eq = rest[km.end() :]
        val, consumed = _parse_such_as_value(after_eq)
        segs = _parse_path_segments(key_path)
        if segs:
            _assign_path(out, segs, val)
        i += km.end() + consumed
        while i < n and blob[i].isspace():
            i += 1
        if i < n and blob[i] == ",":
            i += 1
    return out if out else None


def extract_user_parameter_override(head: str) -> Optional[JSONDict]:
    """Prefer JSON ``Set parameters to: {...}``; else prose ``Set parameters such as:``."""
    j = extract_set_parameters_dict(head)
    if j is not None:
        return j
    return extract_set_parameters_such_as(head)


def infer_openai_node_parameters_from_instruction(text: str) -> Optional[JSONDict]:
    """
    Map common wording to n8n OpenAI node ``parameters.resource`` / ``parameters.operation``.

    Used when the planner collapses the user message into a short \"Insert the node …\" line and
    Phase 2 would otherwise miss explicit \"audio\" / \"transcribe\" intent.
    """
    if not text or not isinstance(text, str):
        return None
    tl = text.lower()
    out: JSONDict = {}

    def _set_audio_op(op: str) -> None:
        out.setdefault("resource", "audio")
        out["operation"] = op

    # Explicit: resource / operation (quoted or not)
    if re.search(
        r"\bresource\s*(?:=|:)?\s*[\"']audio[\"']|\bresource\s+[\"']audio[\"']|\buse\s+resource\s+[\"']audio[\"']",
        text,
        re.I,
    ):
        out["resource"] = "audio"
    if re.search(
        r"\boperation\s*(?:=|:)?\s*[\"']transcribe[\"']|\boperation\s+[\"']transcribe[\"']",
        text,
        re.I,
    ):
        _set_audio_op("transcribe")
    if re.search(
        r"\boperation\s*(?:=|:)?\s*[\"']translate[\"']|\boperation\s+[\"']translate[\"']",
        text,
        re.I,
    ):
        _set_audio_op("translate")
    if re.search(
        r"\boperation\s*(?:=|:)?\s*[\"']generate[\"']|\boperation\s+[\"']generate[\"']",
        text,
        re.I,
    ):
        _set_audio_op("generate")

    # Phrases: transcribe / translate a recording
    if re.search(r"\btranscribe\s+a\s+recording\b", tl) or (
        "transcribe" in tl and re.search(r"\b(recording|record|audio|voice|speech|sound)\b", tl)
    ):
        _set_audio_op("transcribe")
    elif re.search(r"\btranslate\s+a\s+recording\b", tl) or (
        "translate" in tl
        and re.search(r"\b(recording|record|audio|voice)\b", tl)
        and "transcribe" not in tl
    ):
        _set_audio_op("translate")

    # Whisper / speech-to-text style (only with audio-ish words to reduce noise)
    if "whisper" in tl and re.search(r"\b(audio|voice|speech|recording|sound|transcri)\w*\b", tl):
        _set_audio_op("transcribe")

    if out.get("resource") == "audio" and "operation" not in out:
        if "transcribe" in tl:
            out["operation"] = "transcribe"
        elif "translate" in tl:
            out["operation"] = "translate"
        elif "generate" in tl and re.search(r"\b(audio|tts|voice|speech)\b", tl):
            out["operation"] = "generate"

    return out if out else None


def parse_insert_instruction(input_text: str) -> JSONDict:
    inserted, head, loc = _parse_insert_head(input_text)
    return {
        "inserted_node_name": inserted,
        "instruction_head": head,
        "location": loc,
        "declared_node_type": extract_declared_node_type(head),
        "user_parameter_override": extract_user_parameter_override(head),
    }
