# Mapping v1 — promotion evidence packet (sanitized)

**For:** Dan (promotion authority) and Desktop Codex / Terra (deployment executor).
**Candidate:** `topic/mapping-literals-v1 @ 205ea30`. **Product base:** `integration/ollama-product-consolidation @ df35c34`.
**Author:** executor (2026-09-02). **This is not a promotion proposal.** It only states what evidence exists, what is missing, and who must supply each missing piece. executor does not request raw private logs and does not itself promote anything.

## Status at a glance

| Gate | State | Owner of the missing piece |
| --- | --- | --- |
| G1 Code/test evidence (unit) | ✅ met | — (executor independently reproduced) |
| G2 Case A string/boolean n8n execution | ✅ met | — (Dan accepted; sanitized record) |
| G3 Case B number-literal n8n execution | ⛔ pending | Desktop Codex/Dan (run Case B fixture) |
| G4 Target-env rejection matrix re-confirmed | ⛔ pending | Desktop Codex (on deployed image) |
| G5 Independent verification sign-off | ◻ partial | brain + executor (on sanitized evidence) |
| G6 Dan's explicit promotion approval | ◻ not given | Dan |

Promotion of `topic/mapping-literals-v1` into `ollama-widget` requires all of G1-G6. No gate promotes automatically.

## G1 — Code/test evidence (met, independently reproduced)

- `205ea30` diff touches only `chatbot/src/` (8 files); no a2a paths; commit self-marks number literal `implemented_untested/provisional` and "not a promotion or deployment authorization".
- Independently reproduced by executor at `205ea30`: full `node --test chatbot/src/*.test.js` = **328/328 pass, 0 fail**; focused set = **54/54** (nodewiseCompiler 19 + approvedNodewiseCompiler 11 + nodewisePlannerPrompt 2 + runtimeSkillRegistry 6 + capabilityGap 16).

## G2 — Case A (string + boolean) execution (met per Dan's acceptance)

- Per `MAPPING_V1_ACCEPTANCE_RESULT.md`: a manually executed n8n workflow produced `name` (copied), `status="active"` (string literal), `isActive=true` (boolean literal); n8n UI reported success.
- Classification: string/boolean `set_fields` = `verified_fixture`, **bounded to this one fixed public-source case**.
- executor limit: this rests on Dan's assertion + Desktop Codex's sanitized record; executor cannot independently reproduce n8n execution (no .44 reach) and does not request the raw transcript.

## G3 — Case B (number literal) — PENDING, must not be pre-declared successful

- Deterministic fallback spec is ready in `CONTINUOUS_RESEARCH.md` (Q2): users/5 + `set_fields` with `rank` number literal `1`, bypassing the planner.
- Required sanitized readback/execution evidence: Set node assignment `{name:"rank", value:1 (native number, not "1"), type:"number"}`; execution output `rank === 1` as a number.
- Decision rule: native number preserved → number literal advances to `verified_fixture`; stored/executed as string `"1"` → design assumption false, repair before any number promotion; create/exec failure → keep unverified, preserve evidence, stop.
- Until G3 passes, number literals remain `implemented_untested/provisional` and cannot justify promotion of that path.

## G4 — Target-env rejection matrix — PENDING (must stay fail-closed on the deployed image)

Re-confirm on the deployed candidate image (unit- or API-level as appropriate), each reported as actual vs expected:
- unregistered external source rejected (e.g. JSONPlaceholder `/albums/1` → `沒有登錄的回應 schema`);
- duplicate `to`; unknown/extra/mixed mapping or source keys; undeclared field; field/literal type mismatch; null/object/array/NaN/Infinity literal; expression-as-literal; items input — all rejected;
- changed skill registry invalidates an already-issued approval token.
A positive fixture must not weaken any of these.

## G5 — Independent verification sign-off (partial)

- executor has reproduced G1 and audited G2 against the protocol (see Q1 in `CONTINUOUS_RESEARCH.md`).
- Full sign-off waits on G3/G4 sanitized evidence for brain + executor to review together.

## G6 — Dan's promotion approval (not given)

- Per `BRANCH_STRATEGY.md`, promotion to `ollama-widget` needs Dan's explicit approval plus the branch-strategy gates (tests pass, real execution evidence, no secret/runtime-state carried in). Promotion to `main` is a further separate gate.
- This packet does not ask for that approval; it records that G6 is the final human decision after G3-G5 close.

## What executor recommends NOT doing

- Do not promote on G1+G2 alone: the number path is unverified and the target-env matrix is unconfirmed.
- Do not treat deployment/service health as verification (protocol §2).
- Do not merge `codex/autoresearch-a2a` (collaboration record) into any product branch.
