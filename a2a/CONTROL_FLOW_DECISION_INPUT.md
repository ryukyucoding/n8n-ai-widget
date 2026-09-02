# Control-flow (single 2-way IF) — decision input

**Status:** decision input for brain — not a decision, not an implementation authorization.
**Author:** executor (read-only architecture audit, 2026-09-02).
**Scope:** the smallest useful control-flow increment — one 2-way `if` whose branches converge to the existing one_object output contract. No full control-flow engine, no credentials, no pipelineIr adjudication, no code changes. executor does not adjudicate pipelineIr.

## 1. Runtime node facts (read from `chatbot/schemas/runtime_node_schemas.json`, not guessed)

| Node | Latest version | inputs | outputs |
| --- | --- | --- | --- |
| `n8n-nodes-base.if` | 2.3 | `['main']` | **`['main','main']`** (two ports: true, false) |
| `n8n-nodes-base.merge` | 3.2 | dynamic, `numberInputs` default 2 | `['main']` (n→1) |
| `n8n-nodes-base.switch` | 3.4 | `['main']` | dynamic (rules → N ports + optional fallback) |
| `n8n-nodes-base.filter` | 2.3 | `['main']` | `['main']` |

A 2-way IF therefore needs: one If node (2 out-ports) + a Merge node (2 in-ports → 1) if both branches rejoin.

## 2. What a single 2-way IF requires, vs current support

| Requirement | nodewise specification (wired, product) | pipelineIr (unwired, no caller) |
| --- | --- | --- |
| Condition representation | none (no boolean-test construct) | none explicit; edges exist but the test node still needs a config |
| true/false port | **no** — connections are a linear single-target chain: `connections[node[i]] = { main:[[ node[i+1] ]] }` (nodewiseCompiler L242-244) | **yes** — `dependsOn[].branch` (string\|boolean) + `sourcePort` model which port a downstream consumes |
| Merge | none | **yes** — `MERGE_POLICIES = {append, combine_by_index, first}` + multiple `dependsOn` |
| Data shape through branches | one_object/items only, mapping collapses to one_object | **yes** — typed `SingleItem/ItemList/Binary<T>` / `NoOutput` per step |
| Cycle safety | trivial (linear = acyclic) | **yes** — `topologicalOrder` throws `IR contains a cycle at <id>` |
| Source-schema binding ("don't invent fields") | **yes** — `source()` + `assertInputField` against registered/prior schema | **no** — pipelineIr has no source-schema awareness |
| Approval fingerprint / token | **yes** — `computeFingerprint(canonicalizeIr(ir), runtimeSchemaRevision, skillRegistryRevision, src?)`; review/approve/compile bound to the exact IR | **no** — no approval integration; would need porting |
| n8n emitter | yes (linear) | **no** — no caller, no workflow emitter |

Net: pipelineIr already has the *structural* primitives IF needs (ports, merge, shape, cycle); nodewise already has the *safety* stack IF must not lose (source-schema, approval, fail-closed, one_object contract). Neither has both.

## 3. Options

### Option A — Extend nodewise with a bounded IF
- **Minimal change:** add an `if`/`branch` capability + condition config to `validateSpecification`; make `compileNodewiseSpecification` connections multi-output for the If node and emit a Merge node where branches rejoin; extend `finalFields` for the merged output; flip `control.flow` skill to implemented; add prompt grammar + tests.
- **Invariants preserved:** source-schema binding, approval fingerprint (canonicalizeIr must deterministically cover the new branch/condition fields), one_object final contract, fail-closed validation.
- **Risks:** nodewise's connection model is fundamentally linear; retrofitting branch+merge is invasive and *re-implements* ports/merge/cycle-detection that pipelineIr already has → duplication and drift; a bounded IF here may not generalize to further control flow without another rewrite.

### Option B — pipelineIr adapter (nodewise stays the surface)
- **Minimal change:** keep nodewise as the approval/source-schema surface; add an adapter that lowers a *bounded* IF sub-shape into pipelineIr purely for structural validation (topological/cycle/branch/merge), then an If/Merge emitter; nodewise gains a bounded branch capability that maps onto pipelineIr constructs.
- **Invariants preserved:** approval fingerprint stays over the nodewise surface; source-schema/field validation stays in nodewise; pipelineIr used only for structure.
- **Risks:** two IR models kept coherent; lowering complexity; the adapter must bridge field/shape validation between the two; fingerprint must canonicalize the branched surface deterministically.

### Option C — Adopt pipelineIr as canonical IR
- **Minimal change (large):** port source-schema binding + approval fingerprint + a full n8n emitter (incl. If/Merge) onto pipelineIr; migrate existing transforms (select_fields/set_fields/count/join/set_output) and the one_object/declared-output contract onto it.
- **Invariants to re-establish on pipelineIr:** source-schema "don't invent fields", approval-token binding, fail-closed rejection matrix, output contract — all currently proven only on nodewise (incl. the just-accepted Mapping v1).
- **Risks:** largest blast radius; disturbs the freshly `verified_fixture` Mapping v1 surface; migration risk. Strategically cleanest long-term (single IR with native branch/cycle/merge/shape), but should not be bundled with a first IF.

## 4. Recommendation (input only — brain decides, incl. the pipelineIr-canonical question)

For the near-term goal of *one* 2-way IF, **Option B (adapter)** looks like the best balance: it reuses pipelineIr's already-built, already-tested branch/port/merge/cycle primitives instead of re-implementing them in nodewise, while keeping nodewise's source-schema + approval + fail-closed stack (which Mapping v1 just proved) untouched. **Option A** is acceptable only if IF is genuinely the *only* control-flow need for a long time and the duplication is deemed cheaper than an adapter. **Option C** is the right long-term shape but is out of proportion to a single IF and would disturb the just-accepted Mapping v1 — recommend deferring it to a dedicated migration decision.

Whichever path: the first IF should keep the one_object final contract (both branches converge to the same declared output), extend `canonicalizeIr`/fingerprint deterministically over the new fields, and carry a rejection matrix (missing/extra condition keys, non-boolean condition, dangling branch, cycle, branch whose fields ≠ expectedOutput) as unit tests before any deployment — mirroring the Mapping v1 discipline. pipelineIr adjudication and `planReviewGate` archival remain brain's calls; nothing here changes them.
