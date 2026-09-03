# Evidence & data requests for Desktop Codex / Terra / .44

**Status:** consolidated, sanitized request list. Dan has approved the underlying work items and will pass this to Desktop Codex to fulfil in the private environment. Nothing here authorizes deployment or promotion by itself — each item returns *evidence*; brain + executor then verify, and Dan makes any promotion decision.
**Author:** executor (2026-09-02). **Return only sanitized evidence:** revision, categories, structural facts, IDs, statuses, output field/types. **Never** put credentials, secrets, private host addresses, private file paths, or raw dataset rows into A2A.

Priority order is the executor's suggestion; Dan/brain may reorder.

## Req 1 — Case B number-literal n8n execution (unblocks Mapping v1 number path)

- **Source spec (deterministic, bypasses the planner):** the exact `nodewise_step_specification` in `CONTINUOUS_RESEARCH.md` §Q2 (users/5 + `set_fields` with `rank` number literal `1`). Compile/deploy that spec directly on `topic/mapping-literals-v1 @ 205ea30`.
- **Return (sanitized):** the Set node's assignment for `rank` (value + declared type), post-create readback of `rank`'s type, and the manually-executed final output value/type of `rank`.
- **Decision rule (do not pre-declare success):** native number `1` preserved through readback + execution → number literal advances to `verified_fixture`; stored/executed as string `"1"` → design assumption false, keep provisional and report; create/exec failure → keep unverified, preserve failure evidence, stop.

## Req 2 — G4 target-env rejection matrix (Mapping v1 promotion gate)

On the deployed `205ea30` candidate image, confirm each fail-closed rule still holds; report each as **actual vs expected**:
- unregistered external source rejected (e.g. JSONPlaceholder `/albums/1` → `沒有登錄的回應 schema`);
- duplicate `to`; unknown/extra/mixed mapping or source keys; undeclared field; field/literal type mismatch; null/object/array/NaN/Infinity literal; expression-as-literal; items input — all rejected;
- a changed skill registry invalidates an already-issued approval token.
- **Return:** pass/fail per rule (sanitized), plus the running image's reported revision (must equal `205ea30`).

## Req 3 — Easy-100 dataset + mapping-type frequency

- **Provide** `testing_data_low_100.jsonl` into the private environment (it is not in the repo).
- **Run** the existing audit: `node chatbot/tools/audit_easy100_capability_coverage.js --input <that file> --output report.json`.
- **Return (sanitized aggregates only):** case count, per-gap-category counts, cumulative unlock curve. **No raw rows, no private paths.**
- **Mapping-type frequency (field-copy / literal / coercion / items / expression):** the existing audit does not cover this. Design is ready in `MAPPING_CATEGORIZER_DESIGN.md` (input/output schema, rules, T1-T9 tests). First confirm the real jsonl exposes assignment-level ground truth (or how to derive it); implement the categorizer per that design; return only sanitized frequency + unlock counts. **Do not fabricate frequencies.**

## Req 4 — Caller-auth / n8n credential runtime facts (unblocks access-control → credentials)

Confirm against the real n8n instance (see `CALLER_AUTH_DESIGN_INPUT.md` §5). **Return facts, not secrets:**
1. Is the deployed instance behind a reverse proxy (nginx?) that could authenticate callers?
2. Does n8n have user-management / SSO enabled, or is it single-instance API-key only?
3. Is an identity provider available for the widget host (org SSO / OAuth app)?
4. Current CORS / allowed-origin posture on the deployed instance.
5. **Whether the server's n8n API key can actually reach/manage credentials** (create/list credential types) — confirm the real privilege; do not assume.

## Req 5 — If / Merge fixtures (unblocks IF research, Option B contract §7)

Provide, from the real n8n instance, the two facts marked UNKNOWN in `CONTINUOUS_RESEARCH.md` §R1 and `OPTION_B_ADAPTER_CONTRACT.md` §7:
1. **filter-v3 operator allowlist + exact condition JSON shape** — the operators actually available in `n8n-nodes-base.if@2.3` conditions, and the stored `leftValue/operator/rightValue` structure (from a real If node fixture, not guessed).
2. **Mutually-exclusive branch rejoin merge semantics** — for If → (branchA / branchB) → Merge, which Merge mode (`append` / `chooseBranch` / other) and `numberInputs` yields a single one_object result from whichever branch ran; return a real Merge node fixture + a small execution readback showing the item behavior.

## Req 6 — limit_items real n8n fixture (skill #2; passed brain independent review)

- **Candidate:** `topic/limit-items @ 6e9579a` (base `integration/ollama-product-consolidation`). Code + tests only; brain reviewed, no correctness finding; status is **schema-verified / implemented, NOT verified_fixture**.
- **Source spec (deterministic, bypasses planner):** manual_trigger → GET `/todos?userId=1` (items) → `limit_items` (limit 5) → `count_false_boolean` (field `completed`, totalField `totalTodos`, falseCountField `incompleteTodos`) → `set_output` projecting `totalTodos`, `incompleteTodos`. (Exact spec = the `limitSpecification()` fixture in `chatbot/src/nodewiseCompiler.test.js` on that branch.)
- **Return (sanitized):** readback shows an `n8n-nodes-base.limit` node with parameters `{maxItems:5, keep:firstItems}`; manual execution output `totalTodos === 5` (only the first 5 todos survived the limit) plus a numeric `incompleteTodos`. Only these structural facts.
- **Decision rule (do not pre-declare):** readback + execution preserve the limit (Limit node present, exactly 5 items counted) → `limit_items` → `verified_fixture`; if the Limit node/parameter shape differs from `{maxItems, keep}` or the count is not over 5 → keep schema-verified/implemented, report the discrepancy, do not promote; create/exec failure → keep unverified, preserve evidence, stop.

## Req 7 — establish active revision before retrying Req 6

The first Req 6 attempt stopped during compiler validation because the active
service rejected `limit_items` as unsupported. It produced no workflow,
readback, or execution evidence. This does **not** distinguish an old active
image from a candidate deployment failure.

Before retrying the unchanged Req 6 fixture, Desktop Codex must return only
sanitized deployment evidence:

1. `active_service_revision`: full and short revision reported by the running
   service or its deployment record;
2. `candidate_build_evidence`: proof that the image/build was produced from
   `topic/limit-items@6e9579a`;
3. `deploy_evidence`: proof that that candidate image was installed as the
   active service, plus final health/restart/rollback categories;
4. `post_deploy_capability_probe`: a bounded compile-validation probe showing
   whether `limit_items` is accepted before attempting the full fixture.

Decision rules:

- If active revision is not exactly `6e9579a` or is unknown, do not rerun Req 6;
  first correct the deployment and repeat this gate.
- If active revision is exactly `6e9579a` and `limit_items` is still rejected,
  classify as a candidate/compiler integration defect and stop for review.
- Only if revision/build/deploy evidence match may the unchanged Req 6 fixture
  run once more.

Do not return private hostnames, addresses, paths, credentials, raw logs,
session links, or workflow/execution payloads.

## Notes on the approvals Dan gave (sequencing, for transparency)

- **Mapping v1 promotion:** approved by Dan, but still requires Req 1 (Case B) + Req 2 (G4) evidence, then brain+executor independent verification, before the actual merge to `ollama-widget`. Approval does not skip the evidence.
- **planReviewGate cleanup:** approved by Dan; it is product code (`chatbot/src`), so it should go through the normal product path with brain's review when brain returns (~hours) rather than being deleted ad hoc on a research branch. Evidence packet ready in `PLANREVIEWGATE_RETIREMENT_PACKET.md` (impact: suite 328→325).
- **Access control:** approved to proceed to design; implementation waits on Req 4 runtime facts and a chosen option from `CALLER_AUTH_DESIGN_INPUT.md`.
