"""
n8n Workflow Task Decomposer v2

Decomposes a natural language user query into per-operation natural language
sub-tasks (create / modify / delete / insert) without requiring node type or
parameter knowledge.

Unlike v1, this version:
  - Uses a single LLM call (no node identification step)
  - Outputs only {operation, description} per task — no node_type/parameters
  - Optionally asks the user clarifying questions when the query is too vague
    for a downstream agent to act on, then re-runs with the enriched context

Intended use: the output tasks feed into four separate downstream agents,
one per operation type.
"""

import json
import os
import sys
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

MODEL = "gpt-4o"

# ── Prompt ────────────────────────────────────────────────────────────────────

SYSTEM = """\
You are an expert in n8n workflow automation.
You will be given a user request describing changes or additions to an n8n workflow.

Your task: decompose the request into an ordered list of atomic sub-tasks, one per
operation, and identify any critical missing information that would block execution.

Return ONLY a valid JSON object with this structure:
{
  "tasks": [
    {
      "operation": "create" | "modify" | "delete" | "insert",
      "description": "<natural language description of what this sub-task does>"
    }
  ],
  "clarifications": [
    "<question to ask the user>"
  ]
}

Operation semantics — choose carefully:
- create : Build a brand-new workflow from scratch. Use ONLY when the user is
           describing a whole new workflow that does not exist yet.
- insert : Add a new node into an EXISTING workflow.
- modify : Change the configuration/parameters of an existing node.
- delete : Remove an existing node entirely from the workflow.

Disambiguation rules:
- "Build me a workflow that does X" → ALL tasks are create.
- "Add a Slack notification" (existing workflow implied) → insert.
- "Replace node X with node Y" → one delete + one insert.
- "Change the channel in my Slack node" → modify, NOT insert.

Description guidelines:
- Keep each description concise but specific enough for a downstream agent to act.
- Preserve concrete values the user mentioned (URLs, channel names, email addresses).
- Do NOT use technical node names (no "httpRequest", "gmailTrigger", camelCase).

Clarification guidelines — be selective:
- Add a clarification ONLY when a specific concrete value is missing and the
  downstream agent cannot proceed without it.
  Examples that warrant clarifying:
    "改成其他服務"     → which service?
    "發到某個頻道"     → which channel?
    "寄給某個 email"   → which email address?
  Examples that do NOT warrant clarifying:
    "刪掉不需要的部份" → downstream knows context; don't ask
    "加一個觸發器"     → type is inferrable; don't ask
    "改一下設定"       → vague but non-blocking; don't ask
- Maximum 2 clarifications per query. If more than 2 things are unclear,
  pick only the 2 most critical ones.
- If nothing needs clarification, return "clarifications": [].
- Return ONLY the raw JSON — no markdown, no explanation.
"""


# ── Core helpers ──────────────────────────────────────────────────────────────

def _call_llm(client: OpenAI, user_message: str) -> dict:
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user_message},
        ],
        temperature=0,
        response_format={"type": "json_object"},
    )
    return json.loads(response.choices[0].message.content)


def _build_enriched_query(original_query: str, qa_pairs: list[dict]) -> str:
    qa_text = "\n".join(
        f"Q: {pair['question']}\nA: {pair['answer']}"
        for pair in qa_pairs
    )
    return f"原始需求：{original_query}\n\n補充說明：\n{qa_text}"


# ── Public interface ───────────────────────────────────────────────────────────

def decompose_widget_turn(
    user_query: str,
    qa_pairs: list[dict] | None = None,
    api_key: str | None = None,
) -> dict:
    """
    Non-interactive decomposition for HTTP/widget use.

    First call: ``qa_pairs=None``. If the model requests clarifications, returns
    ``{"ok": False, "needs_clarification": True, "questions": [...]}``.
    Follow-up: pass ``qa_pairs=[{"question": q, "answer": a}, ...]`` built from
    the user's replies, matching the order of ``questions``.

    When satisfied, returns ``{"ok": True, "tasks": [{"operation", "description"}, ...]}``.
    """
    client = OpenAI(api_key=api_key or os.environ.get("OPENAI_API_KEY"))
    if qa_pairs:
        user_message = _build_enriched_query(user_query, qa_pairs)
    else:
        user_message = user_query
    result = _call_llm(client, user_message)
    clarifications = [
        c
        for c in (result.get("clarifications") or [])
        if isinstance(c, str) and c.strip()
][:2]
    tasks = result.get("tasks") or []
    if clarifications:
        return {
            "ok": False,
            "needs_clarification": True,
            "questions": clarifications,
            "tasks_draft": tasks if isinstance(tasks, list) else [],
        }
    if not isinstance(tasks, list):
        tasks = []
    return {"ok": True, "tasks": tasks}


def decompose_v2(user_query: str, api_key: str | None = None) -> dict:
    """
    Decompose a natural-language n8n workflow request into per-operation tasks.

    If the query is ambiguous, the user is prompted interactively for
    clarification (max 2 questions), and the result is re-generated with the
    enriched context.

    Args:
        user_query: The user's natural language request.
        api_key:    OpenAI API key. Falls back to OPENAI_API_KEY env var.

    Returns:
        {"tasks": [{"operation": "...", "description": "..."}, ...]}
    """
    client = OpenAI(api_key=api_key or os.environ.get("OPENAI_API_KEY"))

    print("Decomposing query...")
    result = _call_llm(client, user_query)

    clarifications = result.get("clarifications", [])
    if clarifications:
        print(f"\n需要補充 {len(clarifications)} 個資訊：")
        qa_pairs = []
        for question in clarifications:
            print(f"\n{question}")
            answer = input("> ").strip()
            qa_pairs.append({"question": question, "answer": answer})

        print("\nUpdating decomposition with your answers...")
        enriched = _build_enriched_query(user_query, qa_pairs)
        result = _call_llm(client, enriched)

    return {"tasks": result.get("tasks", [])}


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 decompose_v2.py \"<user query>\"")
        sys.exit(1)

    query = sys.argv[1]
    output = decompose_v2(query)

    print("\nDecomposed tasks:")
    print(json.dumps(output, ensure_ascii=False, indent=2))
