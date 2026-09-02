# Mapping-category categorizer — design input (no code, no fabricated frequencies)

**Purpose:** let Desktop Codex/Terra, once they have the Easy-100 dataset in the private environment, implement and run a categorizer that classifies each case's *mapping/transform* requirements into buckets — field-copy, literal, coercion, items, expression — and reports frequency + unlock counts. This document is design only: input/output schema, rules, ambiguities, test cases. **It states no actual frequencies** (the data is not local; see Q4). executor does not run it.

## 0. Where this plugs in

`chatbot/tools/audit_easy100_capability_coverage.js --input <testing_data_low_100.jsonl> --output <report.json>` already produces capability-*gap* coverage via `src/easy100CapabilityCoverage.auditJsonLines`. Mapping-*type* frequency is a different question and is not covered today. This categorizer is a sibling pass, not a change to the existing audit.

## 1. Input schema (per dataset case)

**UNKNOWN — confirm against the real dataset before implementing (do not assume field names).** The categorizer needs, per case, the ground-truth mapping/transform intent. Expected minimum, expressed abstractly:

```
Case = {
  id: string,
  request: string,                 // natural-language ask (context only)
  groundTruth: {                   // exact field names TBD from real jsonl
    outputs: [ { name, type } ],   // declared output fields + primitive types
    assignments: [ AssignmentTruth ]
  }
}
AssignmentTruth = {                // one per produced output field
  target: string,
  // exactly ONE of the following forms should be inferable from ground truth:
  fromField?: string,             // a source/prior field name
  fromFieldType?: type,           // that field's declared type, if known
  literalValue?: any,             // a fixed value
  usesExpression?: boolean,       // n8n expression / template / computed
  overItems?: boolean            // mapping applied per-item over a list
}
```

If the real dataset does not expose assignment-level ground truth (only final workflows), the implementer must first derive `AssignmentTruth` from the ground-truth workflow's Set/Code/transform nodes — that derivation step is itself a design decision to confirm with brain, not to guess.

## 2. Output schema

```
Report = {
  caseCount: int,
  perCase: [ { id, categories: Category[], unlockableBySetFieldsV1: boolean } ],
  frequency: { field_copy:int, literal:int, coercion:int, items:int, expression:int, unclassified:int },
  // "how many cases become buildable if only these categories are supported"
  unlock: { setFieldsV1_only:int, plus_items:int, plus_expression:int }
}
Category ∈ { field_copy, literal, coercion, items, expression, unclassified }
```

All integer counts come from the real run; **this document leaves them unspecified on purpose.**

## 3. Classification rules (deterministic, per assignment; a case may carry several)

1. **field_copy** — target value is a source/prior field, `fromFieldType === target.type`, no computation, single item. (Exactly Mapping v1 `input_field`.)
2. **literal** — fixed value, JS type == target.type, not an expression/template/object/array/null. (Exactly Mapping v1 `literal`.)
3. **coercion** — a field copy whose source type ≠ target type (e.g. number→string), i.e. would need type conversion. (Explicitly *out* of Mapping v1.)
4. **items** — mapping applied across a list (`overItems`), or target derived from aggregating multiple items. (Out of Mapping v1.)
5. **expression** — value needs an n8n expression/template/computation (concatenation, arithmetic, conditionals, `{{ }}`), i.e. neither a plain copy nor a plain literal. (Out of Mapping v1.)
6. **unclassified** — ground truth insufficient to decide; must be counted separately, never silently bucketed.

`unlockableBySetFieldsV1 = every assignment in the case is field_copy or literal AND output is one_object AND no items/expression/coercion present`.

## 4. Human-annotation ambiguities (flag for a human pass, do not auto-resolve)

- A literal that is really a **default for a sometimes-present field** (copy-or-default) — copy vs literal ambiguous.
- A value that is a field copy **plus a rename only** vs a copy **plus formatting** (formatting → expression, not copy).
- **Numeric-looking string** literals ("1" vs 1) — ties into the Case B number-literal question; annotate type explicitly.
- Single-item extraction from a list (`items[0].x`) — items vs field_copy boundary.
- Concatenating two fields — expression, but a naive parser might see two copies.
These should be surfaced as `unclassified` with a reason, then human-annotated; never guessed into a concrete bucket.

## 5. Test cases (deterministic fixtures for the categorizer itself; no dataset needed)

| # | AssignmentTruth (abstract) | Expected category |
| --- | --- | --- |
| T1 | `{target:name, fromField:name, fromFieldType:string, target.type:string}` | field_copy |
| T2 | `{target:status, literalValue:"active", target.type:string}` | literal |
| T3 | `{target:rank, literalValue:1, target.type:number}` | literal |
| T4 | `{target:idText, fromField:id, fromFieldType:number, target.type:string}` | coercion |
| T5 | `{target:count, overItems:true}` | items |
| T6 | `{target:full, usesExpression:true}` (e.g. first+" "+last) | expression |
| T7 | ground truth missing assignment detail | unclassified |
| T8 | case = only T1+T2 | `unlockableBySetFieldsV1 = true` |
| T9 | case = T1+T5 | `unlockableBySetFieldsV1 = false` |

The implementer should encode T1-T9 as unit tests so the categorizer's rules are verified before it is pointed at the real dataset.

## 6. Guardrails

- Do not fabricate any frequency; all counts come from the real private run.
- Confirm the real jsonl field names and whether assignment-level ground truth exists before implementing §1.
- Report `unclassified` honestly; a high unclassified rate is a finding, not a number to hide.
- Return only sanitized aggregates to A2A; keep raw dataset rows in the private environment.
