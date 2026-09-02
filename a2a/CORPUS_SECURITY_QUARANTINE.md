# Easy-100 Source Corpus Security Quarantine

**Status:** active security quarantine as of 2026-09-02.

**Affected artifacts:**

```text
chatbot/corpus/source/testing_data_low_100.jsonl
chatbot/corpus/planner_corpus.json
```

**Decision authority:** Dan selected immediate isolation pending private review.

## 1. Why this artifact is quarantined

Sanitized independent scans found credential-like material in the raw
assistant-workflow payloads in the source corpus. At least one finding has a
real-looking authorization-token shape rather than an obvious placeholder.
Additional query-value candidates and personal-contact material need private
semantic review. A later scan found that the derived planner corpus has no
matching high-confidence authorization-token shape, but it has one unresolved
key-shaped candidate; it is therefore quarantined too.

No values, raw lines, private URLs, record contents, or credential identifiers
are repeated in this public record.

The corpus is therefore not safe to treat as ordinary test input merely because
it is checked into Git.

## 2. Immediate containment

Until Dan closes this quarantine:

- Do **not** feed the affected JSONL to any model, planner, categorizer, agent,
  external service, prompt, attachment, or issue body.
- Do **not** run corpus-building/audit commands that read this file.
- Do **not** copy, export, paste, screenshot, or redistribute its raw records.
- Do **not** write its candidate values into A2A, logs, commits, handoffs, test
  fixtures, or chat.
- The pre-existing derived planner corpus is also quarantined; do **not** use
  it for compiler-level or planner-level runs until its unresolved candidate has
  a private sanitized disposition.
- Standard corpus builder, capability-audit, and planner-corpus runner entry
  points fail closed for both named artifacts. This is an entry-point guard, not
  a claim that arbitrary code that manually reads/copied corpus text cannot
  bypass it; agents must continue to follow this policy.
- Do **not** delete, redact, rewrite Git history, revoke credentials, or change
  raw corpus data without Dan's explicit remediation decision.

Existing local checkouts may already contain the tracked file. Do not create
additional copies; do not attempt ad-hoc cleanup that could destroy evidence or
rewrite history.

## 3. Required private remediation sequence

Desktop Codex / Terra, in an approved private environment, must:

1. Inspect only the candidate locations identified by the sanitized security
   scan, without returning values to A2A.
2. Determine whether each candidate is a placeholder, inactive example, or
   potentially live third-party credential.
3. If any is possibly live, identify the appropriate owner through a private
   channel and request/perform revocation or rotation only with authority.
4. Report a sanitized disposition for every candidate:

```text
candidate category | placeholder/inactive/rotated/unknown | action taken | safe to sanitize?
```

5. Propose a sanitized source representation that preserves the research fields
   actually required for reproducibility while removing raw secret-bearing
   workflow content.

## 4. Re-enablement gate

The artifact may be used again only after all are true:

1. Private review records no live credential, or applicable credentials have
   been revoked/rotated.
2. A sanitized replacement is reviewed and tested for the intended use.
3. Brain/executor verify that the replacement contains no identified secret or
   personal-contact material beyond explicitly approved research fields.
4. Dan explicitly authorizes re-enablement for a named purpose, such as corpus
   regeneration or mapping categorization.

A Git history rewrite, replacement commit, or deletion is a separate destructive
remediation decision. It is not implied by re-enablement.

## 5. Current impact on research

| Workstream | Status while quarantined |
| --- | --- |
| Easy-100 source rebuild | blocked |
| Mapping categorizer implementation/run | blocked on sanitized source |
| Planner/model input from this JSONL | prohibited |
| Existing Mapping v1 fixture evidence | unaffected |
| Control-flow/credential architecture research | unaffected |

## 6. Safe reporting format

A2A reports may contain only sanitized counts, categories, remediation status,
and commit/ref identifiers. They must not contain candidate values, raw lines,
private paths, session URLs, host details, credentials, or PII.
