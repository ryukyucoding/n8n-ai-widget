# Mapping v1 Deployment & Independent Verification Protocol

**Status:** Deployment proposal — not deployment authorization

**Prepared by:** brain (2026-09-02)

**Candidate:** `topic/mapping-literals-v1` @ `205ea30`

**Product base:** `integration/ollama-product-consolidation` @ `df35c34`

## 1. Purpose

This protocol tests the current runtime-aware compiler result in a real n8n
runtime without confusing implementation, deployment, and verification.

The candidate adds a bounded `data_transform` operation, `set_fields`:

- one declared `one_object` input produces one `one_object` output;
- an output field can copy/rename a declared input field; or
- an output field can use a typed fixed literal;
- field existence and exact primitive type are validated before compilation;
- duplicate output fields, expressions, arrays, objects, null, non-finite
  numbers, items input, coercion, dynamic paths, and arbitrary code are
  rejected.

It does **not** add control flow, credentials, external writes, items mapping,
expressions, arbitrary JavaScript, `pipelineIr` adoption, or any change to an
existing deployment branch.

## 2. Why execution and verification are separated

A deployer can prove that commands ran. That does not prove that the compiler
is correct, that a workflow executed, or that the result matches the requested
contract. To avoid self-certification:

| Role | Responsibility | Must not do |
| --- | --- | --- |
| Desktop Codex / Terra — deployment executor | Fetch exact revision, build/deploy only when Dan authorizes, run predeclared mechanical checks, preserve raw evidence | Change code/prompt/model/configuration to make a check pass; redefine success; self-certify the research result |
| brain + executor — independent verification | Check revision/provenance, inspect sanitized evidence against this protocol, test rejection boundaries, classify maturity accurately | Deploy, reinterpret failed evidence as success, or relax criteria after seeing a result |
| Dan — human acceptance authority | Grant deployment/promotion approval, use the real n8n UI, execute workflows, decide whether the experience is acceptable | Be treated as having approved deployment merely by reading this document |

The deployment executor may collect workflow IDs, readback JSON, execution IDs,
and raw output in the approved private environment. The verification conclusion
belongs to brain/executor using the predeclared criteria below, with Dan as
final acceptance authority.

## 3. Branch and authorization boundary

### Exact source

Only deploy the immutable candidate revision:

```text
topic/mapping-literals-v1 @ 205ea30
```

Do **not** deploy `codex/autoresearch-a2a`: it is the collaboration record, not
the product source. Do **not** move `main` or `ollama-widget` as part of this
test. Do **not** deploy a local working tree whose `HEAD` differs from the
candidate revision.

### Required authorization

Before any approved-environment change, Dan must explicitly authorize all of:

1. deployment of this exact ref/revision;
2. the allowed test window and target environment;
3. creation of the inactive test workflows; and
4. manual n8n execution of those workflows.

This document authorizes neither deployment nor branch promotion by itself.

## 4. Pre-deployment gates

Desktop Codex must report each result through the approved private coordination
channel before deployment continues.

### 4.1 Revision and worktree

In the approved product checkout:

```text
1. Check the product worktree for unreviewed changes.
2. Fetch `topic/mapping-literals-v1`.
3. Detach at `205ea30`.
4. Record the full and short revision.
```

Required evidence:

- The relevant product worktree is clean; otherwise stop without restore.
- Detached `HEAD` is exactly `205ea30`.
- No unreviewed local patch is silently retained.

### 4.2 Build and automated test gate

Before treating the image as deployable, run the candidate's relevant test
suite from the candidate checkout/image. The independently reproduced local
baseline is:

```text
Focused Mapping v1 tests: 54/54 pass
Full chatbot source tests: 328/328 pass
```

Any different failure count, dependency failure, or skipped test must be
reported as such. Do not call a partial test run equivalent to `328/328`.

### 4.3 Approval-secret safety

The plan-approval secret binds a reviewed plan to its approval token. Rotating
it invalidates outstanding approvals. Before deploying:

- confirm no user is actively reviewing a plan;
- generate any fresh secret only inside the approved private environment;
- never print it, save it to Git, paste it into A2A, or include it in reports.

## 5. Controlled deployment

Use the private operations runbook available in the deployment environment only
after Dan's exact authorization. The deployment executor must record through
the approved private coordination channel:

- approved ref and full/short revision;
- command sequence and complete private output;
- focused image-test result;
- service status and restart count;
- health/configuration response categories;
- whether rollback happened.

If the deployment procedure reports a test failure, rollback, unexpected
revision, or unhealthy final status: **stop**. Do not modify environment
configuration, credentials, model selection, schemas, prompt text, or code in
place.

## 6. Mechanical post-deployment checks

These checks establish that the expected service and compiler guardrails are
live. They are necessary but insufficient for a research success claim.

Required evidence:

| Check | Required result |
| --- | --- |
| Health endpoint | Service returns its documented healthy status |
| Model configuration | Plan-first is enabled only if the approved test configuration intended it; record the displayed planner model, do not assume it |
| Compiler corpus | `12/12` and no listed compiler failure |
| Revision | Running image/service report matches `205ea30` |

Also send a negative plan-review request using an allowed-host but unregistered
source endpoint such as JSONPlaceholder `/albums/1`. It must reject with:

```text
沒有登錄的回應 schema
```

Acceptance would prove that the deployed image lacks source-schema protection;
stop and classify the deployment verification as failed.

## 7. Real n8n Mapping v1 verification

Static tests and workflow creation are not execution evidence. The required
path is:

```text
natural-language request
→ constrained planner
→ reviewable plan
→ explicit approval
→ deterministic compiler
→ n8n create
→ post-create readback
→ manual n8n execution
→ output-contract inspection
```

For each case, preserve only safe evidence: revision, request category, plan
outcome, workflow ID/name, readback structural facts, execution ID/status, and
output fields/types. Do not put credentials, host addresses, private paths, or
secrets in reports.

### Case A — string and boolean literals (required acceptance case)

Suggested request:

> 抓取 JSONPlaceholder 使用者 5 的資料，輸出姓名，並加入固定欄位 status = active 與 isActive = true。

Expected result:

1. Planner returns a reviewable supported plan using `set_fields`, not raw n8n
   JSON.
2. User explicitly approves the exact plan.
3. Compiler creates an inactive workflow through the normal create adapter.
4. Readback contains an Edit Fields/Set node whose assignments include:
   - raw string `"active"` with type `string`;
   - native boolean `true` with type `boolean`;
   - copied `name` as an n8n field expression.
5. Dan manually executes the workflow in n8n.
6. Execution succeeds and final output contains the requested name, `status`,
   and `isActive` with the expected values/types.

Only after all six conditions may the string/boolean literal portion be called
`verified_fixture`.

### Case B — number literal (exploratory; never predeclare success)

Suggested request:

> 抓取 JSONPlaceholder 使用者 5 的資料，輸出姓名，並加入固定欄位 rank = 1。

The compiler currently emits a native JSON number for `rank`. Existing source
and unit tests support this design, but no real fixed-number n8n Set fixture has
yet verified its stored/executed parameter shape.

Classify evidence exactly:

| Observation | Correct conclusion |
| --- | --- |
| Readback and manual execution preserve numeric `rank: 1` | Number literal advances to `verified_fixture` |
| Readback stores string `"1"` | Compiler representation assumption is false; keep unverified and repair before promotion |
| Create/execution fails | Keep unverified; preserve failure evidence and stop |
| Planner does not choose `set_fields` | Planner/prompt selection is unverified; do not use it as compiler success evidence |

Until Case B has passing execution evidence, number literal remains:

```text
implemented_untested / provisional
```

It cannot justify deployment promotion or a product-success claim.

## 8. Required rejection regression checks

In addition to positive cases, the verifier must confirm that Mapping v1 has not
weakened the fail-closed boundary. Use unit/API-level evidence as appropriate:

- duplicate output target is rejected;
- unknown or extra mapping/source keys are rejected;
- a field not declared by source/previous output is rejected;
- field source type mismatch is rejected;
- literal type mismatch, null, object, array, `NaN`, and `Infinity` are rejected;
- string expression masquerading as a literal is rejected;
- `items` input is rejected;
- unregistered external source schema is rejected;
- changed skill registry invalidates an already-issued approval token.

The executor/brain verification report must separate each check's actual result
from any expected result.

## 9. Result classification and next decision

| Evidence level | Meaning | Allowed statement |
| --- | --- | --- |
| Unit-tested | Local deterministic validation/compiler tests passed | `已實作且有測試` |
| String/boolean manual execution passed | One fixed n8n end-to-end case passed | string/boolean literals are `verified_fixture` |
| Number has no passing runtime fixture | Design is implemented but runtime representation remains unproven | number literal is `implemented_untested / provisional` |
| Deployment/service only | Image runs; no manual workflow result | Do not call Mapping v1 verified |

No result automatically promotes a branch. After Terra supplies sanitized
execution evidence and brain/executor independently review it, Dan decides
whether to:

1. retain the topic branch as a verified experiment;
2. merge it into `ollama-widget` for further controlled testing;
3. repair a failed invariant; or
4. revert/abandon it.

Promotion to `main` requires the separate branch strategy gates, including
actual execution evidence and Dan's explicit approval.

## 10. Failure handling

If any command or acceptance condition differs from this protocol:

1. stop at that stage;
2. preserve complete, sanitized evidence in the approved private channel;
3. report the exact revision and observed result to brain/executor and Dan;
4. do not retry by changing code, credentials, model selection, prompt,
   runtime schema, deployment configuration, or acceptance criteria;
5. do not claim success from an earlier layer of evidence.
