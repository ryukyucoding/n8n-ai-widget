# Security Quarantine — Do Not Process This Source

`testing_data_low_100.jsonl` is under an active security quarantine as of
2026-09-02 because raw assistant-workflow payloads may contain credential-like
or personal-contact material.

Until the quarantine is explicitly lifted:

- do not use this source for corpus generation, categorization, model input,
  testing, or external processing;
- do not copy or expose raw records;
- do not redact/delete/rewrite it without the remediation authority specified
  in `a2a/CORPUS_SECURITY_QUARANTINE.md`.

The canonical policy and re-enablement gate are in:

```text
a2a/CORPUS_SECURITY_QUARANTINE.md
```
