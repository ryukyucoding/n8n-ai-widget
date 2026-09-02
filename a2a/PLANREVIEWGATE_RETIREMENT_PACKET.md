# planReviewGate retirement — evidence packet

**Status:** evidence only. executor does **not** delete, archive, deprecate, or edit `planReviewGate`. Deletion/consolidation is Dan's gate and needs brain consent (Dan's stated rule). This packet exists so that, once Dan agrees, a future cleanup is a mechanical, low-risk change with the impact known in advance.
**Author:** executor (2026-09-02, read-only grep/export/caller/test audit).

## 1. What it is / why it is a retirement candidate

`chatbot/src/planReviewGate.js` (81 lines) exports `REVIEW_STATES`, `proposePlanReview`, `applyPlanReviewDecision`, `canCompileApprovedPlan`. It fingerprints a **human-readable plan** and gates compilation on a plan-review state machine (proposed → revision_requested → approved → cancelled).

Spec-review finding **A1** established that approval must bind to the **IR the compiler actually consumes**, not a human plan. `approvedNodewiseCompiler` implements that (review rendered from, approval signed against, and compiler fed the *same* nodewise specification). So `planReviewGate`'s approach is superseded on the product path.

## 2. Caller / reference audit (grep, whole chatbot tree)

- **Production callers: none.** No non-test file `require`s `planReviewGate` or calls its exports.
- **Only references:**
  - `chatbot/src/planBinding.js` L5 / L15 / L18 — **comments** explaining why the A1 design replaced it (no `require`, no runtime use).
  - `chatbot/src/planReviewGate.test.js` (42 lines, 3 tests) — tests the module's own exports; imports nothing else from it.
- **Docs:** referenced only in the A2A research record (COMPILER_EXPANSION_ANALYSIS, CONTINUOUS_RESEARCH V3). No product doc depends on it.
- `REVIEW_STATES` enum values are not imported or reused by any other module (approvedNodewiseCompiler uses its own review flow, `reviewNodewisePlannerResult`).

## 3. What must be preserved / migrated before deletion

- **The A1 rationale** (human-plan-hash vs IR-hash) — already preserved in `planBinding.js` comments + `COMPILER_EXPANSION_ANALYSIS.md` + CONTINUOUS_RESEARCH V3. **No migration needed**; deleting the module does not lose the lesson.
- **No functions/state to migrate** — nothing outside the module (and its own test) uses `REVIEW_STATES` / `proposePlanReview` / `applyPlanReviewDecision` / `canCompileApprovedPlan`.
- **The `planBinding.js` comments** that name `planReviewGate` should be lightly updated at cleanup time to read as historical ("superseded and removed") so they don't dangle — a comment-only touch, listed here so it isn't forgotten.

## 4. Deprecate vs delete

- **Deprecate (interim, lowest risk):** add an `@deprecated` note to `planReviewGate.js` pointing at `approvedNodewiseCompiler`, keep the file + test. Zero behavior change; signals intent without removing anything. This is still a code edit → needs Dan's approval + brain consent; executor does not do it now.
- **Delete (full cleanup):** remove `chatbot/src/planReviewGate.js` and `chatbot/src/planReviewGate.test.js`; update the `planBinding.js` comments; re-run the suite. Safe because there are no production callers.

## 5. Impact of full deletion (known in advance)

- **Test count:** removing `planReviewGate.test.js` drops its 3 tests (full chatbot suite 328 → 325). No other test imports the module, so nothing else breaks.
- **Product behavior:** none — the module is already unwired (V2/V3).
- **Verification before/after:** `grep -rn planReviewGate chatbot --include='*.js'` should return only the (to-be-updated) `planBinding.js` comments after deletion; the full suite should stay green at 325/325.

## 6. Recommendation (input only)

Retirement is safe. Suggested order once Dan agrees: (1) `@deprecated` note now as the reversible interim; (2) delete both files + tidy the `planBinding.js` comments as one small cleanup commit at a moment Dan approves. executor performs neither without Dan's delete/consolidate approval and brain consent; this packet just makes that future step mechanical.
