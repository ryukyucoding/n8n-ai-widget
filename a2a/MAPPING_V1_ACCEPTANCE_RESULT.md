# Mapping v1 Acceptance Result (Sanitized)

**Date:** 2026-09-02

**Candidate:** `topic/mapping-literals-v1 @ 205ea30`

**Acceptance authority:** Dan

**Protocol:** `a2a/DEPLOYMENT_VERIFICATION_PROTOCOL.md`

## Decision

Dan reports that the predeclared deployment and verification sequence completed
successfully and accepts the string/boolean Mapping v1 fixture. The execution
evidence reviewed by Desktop Codex shows a manually executed n8n workflow with
successful final output:

| Field | Observed value | Required type |
| --- | --- | --- |
| `name` | `Chelsey Dietrich` | string copied from the declared source |
| `status` | `active` | fixed string literal |
| `isActive` | `true` | fixed boolean literal |

The visible workflow path was manual trigger -> public user request -> shape
-> output, and the n8n UI reported a successful execution. This is execution
evidence, rather than only compiler JSON or workflow creation evidence.

## Classification

Subject to the predeclared protocol gates reported complete by Dan, the
string/boolean `set_fields` fixture is classified as:

```text
verified_fixture
```

This claim is bounded to one fixed public-source case. It does not establish a
general natural-language n8n generator, arbitrary field mapping, expressions,
items mapping, credentials, external writes, control flow, or arbitrary code.

The number-literal case remains:

```text
implemented_untested / provisional
```

until its separate fixed-number n8n fixture has passed readback and manual
execution exactly as required by the protocol.

## What Was Demonstrated

1. A constrained planner can select the bounded `set_fields` capability instead
   of emitting raw n8n workflow JSON.
2. The approved specification can be compiled deterministically to an n8n
   workflow containing typed field assignments.
3. A copied source field, a fixed string literal, and a native boolean literal
   survive the real n8n workflow execution path with the intended output shape.
4. Mapping v1 remains fail-closed by design: field/source/type validation and
   rejection rules remain part of the acceptance contract rather than being
   replaced by runtime best effort.

## Evidence Handling

The full deployment command transcript and raw private-environment evidence
remain outside this public collaboration record. This report preserves only the
candidate revision, result category, visible output contract, and maturity
classification. It must not be read as a claim based solely on service health.

## Recommendations

1. Run Case B (`rank = 1`) as a separate exploratory fixture. Promote number
   literals only if n8n readback and manual execution preserve a native number.
2. Keep the `/albums/1` unregistered-source rejection and the Mapping v1
   rejection matrix in every future candidate verification; a positive fixture
   must not weaken the fail-closed boundary.
3. Make the Mapping v1 focused `54/54` and full `328/328` suites explicit
   pre-deployment gates in the private deployment procedure. The existing
   generic deployment script alone is not sufficient evidence for this
   candidate's changed compiler files.
4. Send this sanitized result to brain/executor for the independent review
   required by the protocol. No branch promotion follows automatically from
   this result; Dan decides any later promotion separately.
