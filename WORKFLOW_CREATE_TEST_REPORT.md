# Workflow Create Test Report

## Scope

This report records Create workflow testing for the n8n AI Widget. The Create
model is `qwen2.5-coder-32b-ft-original:latest`. Each case is considered
successful only when the workflow is created, displayed on the n8n canvas, and
can be executed with the expected result where execution is applicable.

## Test Environment

- n8n and chatbot run in Docker on the project server.
- The chatbot creates workflow JSON through the Qwen fine-tuned model.
- Before writing to n8n, the chatbot validates JSON syntax, workflow shape,
  connections, node types, node type versions, and node parameters.
- Node definitions are exported from the running n8n container: 554 node types
  were exported and no module was skipped.

## Summary

| Case | Workflow type | Create | Canvas | Execute | Result |
| --- | --- | --- | --- | --- | --- |
| C01 | Manual + HTTP GET + Set | Pass | Pass | Pass | Pass |
| C02 | Webhook + score condition | Pass | Pass | Pass | Pass |
| C03 | Daily schedule + Set data | Pass | Pass | Pass | Pass |
| C04 | Manual + Code test-data filter | Pass after fixes | Pass | Pass | Pass |
| C05 | Manual + HTTP + IF + Set branches | Pass | Pass | Pass | Pass with layout issue |
| C06 | Schedule + HTTP + Code filtering/formatting | Pass | Pass | Pass | Pass |
| C07 | User + todo HTTP summary | Pass | Pass | Pass | Pass on 2026-08-04; prior regressions retained below as history |

## C01: Manual Trigger, HTTP GET, and Set

### User request

Create a manually triggered workflow that sends an HTTP GET request and writes
the response into a Set node.

### Expected workflow

`Manual Trigger -> HTTP Request -> Set`

### Result

- Workflow was created and displayed correctly.
- Execution succeeded.
- The HTTP request returned one item from JSONPlaceholder and the Set node
  displayed the expected response fields.

### Problems and resolution

No workflow-generation or execution issue was found in this case. C01 became
the baseline confirming that the basic Create path, n8n API injection, canvas
navigation, and execution log display worked together.

## C02: Webhook Score Condition

### User request

Create a Webhook workflow that accepts a POST request. If `body.score > 80`,
set status to `pass`; otherwise set status to `fail`.

### Expected workflow

`Webhook -> IF score > 80 -> Set Pass / Set Fail`

### Result

- Workflow was created and displayed correctly.
- Both branches were executed successfully.
- Score `90` reached the pass branch; score `70` reached the fail branch.

### Problems and resolution

1. Opening the webhook URL in a browser sent a GET request, while the workflow
   only registered POST. n8n correctly returned a 404-style webhook message.
2. The initial test command was entered in Windows Command Prompt even though
   it used PowerShell syntax. Later `curl.exe` tests also had JSON quoting
   issues.
3. Testing was standardized with PowerShell `Invoke-RestMethod` and a JSON body
   created by `ConvertTo-Json`.

### Finding

The workflow itself was correct. The failures were client-side test-method
issues, not model or n8n workflow issues.

## C03: Daily Reminder Schedule

### User request

Create a workflow that runs every day at 9 AM and sets data with
`message: "daily reminder"` and `priority: "high"`.

### Expected workflow

`Schedule Trigger -> Set`

### Result

- Workflow was created and displayed correctly.
- Manual execution succeeded.
- Output contained `message = daily reminder` and `priority = high`.

### Problems and resolution

No issue was found. This test confirmed that the model generated the required
schedule interval array in the n8n-compatible format.

## C04: Code Node Test Data and Filtering

### User request

Create a manually triggered workflow that creates three test records containing
`name` and `score`, then uses a Code node to filter records where `score > 60`.

### Final workflow

`Manual Trigger -> Create Test Data (Code) -> Filter by Score > 60 (Code)`

### Final result

- Workflow was created and displayed correctly.
- Execution succeeded in about 112 ms.
- The first Code node produced three records.
- The second Code node output two records: Alice (75) and Charlie (92).

### Problems encountered

1. **Outdated Set configuration**
   - The model initially generated `mode: "rawData"` and `values` for a Set
     node.
   - The installed n8n Set node did not support `rawData`; its current schema
     uses different parameter names and modes.
   - This caused an n8n execution error before the runtime-schema mechanism was
     introduced.

2. **The model replaced the requested Code node**
   - Early outputs used Set, Split Out, and Filter nodes instead of Code.
   - The system prompt and retry instruction were strengthened so explicitly
     named nodes in the user request are treated as mandatory.

3. **Old local schema snapshots did not match the deployed n8n version**
   - The repository's previous `node_schemas` files were not sufficient as a
     source of truth for the current server version.
   - A runtime exporter was created to load the actual node definitions inside
     the n8n container.

4. **Need for generic parameter validation**
   - The first attempted solution used rules for individual nodes. This was not
     maintainable and could become an endless list of exceptions.
   - The design was replaced with generic validation against runtime-exported
     schemas, including parameter names, basic types, valid option values,
     versions, and conditional display rules.

5. **Conditional parameter visibility**
   - Code node parameter `jsCode` is shown only when its mode and language
     conditions are satisfied.
   - The validator originally checked only model-provided values and ignored
     n8n defaults, causing a false rejection of valid `jsCode`.
   - The validator now evaluates conditions using schema defaults plus the
     generated parameters.

6. **Incorrect fuzzy node-type alignment**
   - A local fallback registry did not list `n8n-nodes-base.code`.
   - The aligner incorrectly changed it to
     `@n8n/n8n-nodes-langchain.code` because both types end in `code`.
   - This made the validator use the wrong parameter schema.
   - The aligner now combines the runtime type registry with the API registry
     and never performs fuzzy replacement across namespaces.

7. **Incorrect Code-node version in the generation prompt**
   - The prompt previously described Code as typeVersion 2.
   - Runtime inspection showed the generated workflow should use version 1 for
     this case.
   - The prompt was corrected and the Code node was guided to create static
     test data directly instead of using a Set node as an intermediate holder.

### Resolution outcome

After the runtime schema export, generic validation, default-aware
`displayOptions` handling, and safe type alignment were added, the model
generated a valid two-Code-node workflow that executed successfully.

## Architecture Improvements Made During Testing

1. JSON mode and deterministic first-pass generation are used for the Qwen API
   request.
2. Workflow validation occurs before the n8n Create API call. Invalid workflows
   are rejected instead of creating blank or broken canvases.
3. The model may regenerate once after receiving validation feedback.
4. The runtime schema exporter validates installed node definitions directly
   from n8n. The latest export contained 554 node types and zero skipped
   modules.
5. Create validation uses the versioned runtime schema export.
6. Insert and Modify Agent pipelines prefer the same runtime-generated schema
   directory instead of relying on the older static snapshot.
7. Node type alignment is namespace-safe, preventing a base n8n node from being
   converted into an unrelated LangChain node with a similar name.
8. Generated node positions are de-duplicated before creation so nodes on
   separate branches remain readable on the canvas.
9. Runtime connection-port validation now checks source/target connection
   types and input indices. It resolves both static ports and n8n's
   declarative dynamic-input pattern, so a workflow cannot point to a
   non-existent canvas input port.
10. A read-only semantic review stage has been added for deployment testing.
    It uses `gpt-oss:120b` through the existing Insert/Delete model endpoint,
    but it does not call those mutation pipelines. After structural validation,
    it compares the original request with the workflow's data flow and output
    intent. A material mismatch can request the one permitted regeneration.
    The reviewer has its own retry budget: non-JSON reviewer output is retried
    by the reviewer and never consumes the Create model's regeneration.
11. Node canonicalization now uses a shared n8n top-level-field allowlist.
    Model-added editor or validator metadata is stripped generically before
    validation, while required node fields and runtime parameter validation
    remain strict.

## C05: HTTP Request and Conditional Status

### User request

Create a manually triggered workflow that GETs
`https://jsonplaceholder.typicode.com/todos/1`. If `completed` is false, set
status to `pending`; otherwise set status to `completed`.

### Result

- The workflow was created and executed successfully.
- The response had `completed = false`, so the `Set Pending` branch ran as
  expected.

### Problem and resolution

- The two final Set nodes were generated at the same canvas coordinates and
  overlapped visually.
- A generic position de-duplication step was added after validation. When two
  nodes share a position, later nodes are moved down by 140 pixels without
  changing workflow connections or behavior.

## C06: Daily Todo Check

### User request

At 9 AM each day, fetch todos, keep incomplete items for user 1, and format
each result with `title`, `completed`, and `priority: high`.

### Result

- Workflow: `Schedule Trigger -> Get Todos -> Filter Todos -> Format Output`.
- Manual execution succeeded.
- HTTP Request returned 200 items; filtering returned 9 incomplete items for
  user 1.
- Final output contained the requested `title`, `completed: false`, and
  `priority: high` fields for all 9 items.

### Finding

The model successfully generated a more realistic multi-step workflow using a
schedule, HTTP request, and two Code transformations.

## C07: Todo Summary Tool

### User request

Create a manually run todo summary that fetches JSONPlaceholder user 1 and the
same user's todos, then outputs name, email, total todo count, and incomplete
count.

### Result

- This case has produced several generated variants. An earlier variant
  executed but returned `completedTodos: 11` instead of the requested
  incomplete count. The latest generated workflow (ID `109HAPoTrG4gQDA1`)
  reached the `Process Todos` Code node but failed at execution.
- Latest runtime error: `$input.item is not a function [line 2]`.

### Findings

1. The latest workflow did not implement both required sources. `Manual
   Trigger` connected only to `Get User Data`; `Get Todos` had no incoming
   connection and therefore could not run as part of the workflow.
2. The default Append Merge cannot be assumed to yield one user object and one
   todo-array item. The generated Code node tried to read two input values with
   `$input.item(0)` and `$input.item(1)`, but that function is not available in
   the deployed Code-node runtime.
3. The Semantic Reviewer did correctly reject earlier count logic, but it did
   not reliably reject the final orphaned-source/data-shape workflow. This is
   a semantic-review false negative and demonstrates why a Planner-produced
   `Workflow Spec` is needed before generation.
4. C07 is currently an execution and semantic failure, not a pass. It is the
   primary regression case for the future Planner, Semantic Verifier, and
   execution-diagnostics stages.
5. The initial canvas showed a Merge connection rendered at the node's top
   edge instead of a visible `Input 1`/`Input 2` socket. Runtime inspection
   showed Merge v3.2 generates its inputs dynamically from `numberInputs`
   (default 2). The workflow format uses zero-based target indices: the two
   default inputs are indices 0 and 1. Connection-port validation was added
   so an out-of-range index such as 2 is rejected before calling the n8n API.
6. A follow-up generated workflow used only Merge `Input 2`, while `Input 1`
   was not connected. It executed because Append mode permits a single branch,
   but it did not satisfy the requested user-and-todo merge. This is recorded
   as a semantic data-flow issue, not a generic port-validity violation: some
   workflows may intentionally connect only a subset of a multi-input node.

### Latest retest and next architecture step

The latest C07 retest confirmed that the frontend progress display is useful:
the user can see generation, structural validation, semantic review, and any
regeneration rather than waiting without feedback. The workflow was not
created because the first candidate used invalid ports, while the regenerated
candidate still failed the semantic check: its aggregate Code node received a
todo item as its direct input and did not retrieve `name` and `email` from the
earlier user request node.

The next improvement is a Planner-produced `Workflow Spec`. Before Qwen
generates n8n JSON, gpt-oss produces a compact contract containing data
sources, required output fields, data-flow requirements, assumptions, and any
truly required user inputs. Both Qwen and the Semantic Reviewer receive that
same contract. This is intended to make requirements such as "user name and
email must reach the aggregate step" explicit without adding a C07-specific
rule.

### End-to-end execution evidence — 2026-08-04

This evidence was collected after deployment of the bounded terminal repair
candidate mechanism and the immutable acceptance contract.

- Workflow: `Get User 1 Data and Todos`
- Workflow UI: <https://widm-n8n.csie.ncu.edu.tw/workflow/6m9IQUGGrzjwoD6t>
- Execution UI: <https://widm-n8n.csie.ncu.edu.tw/workflow/6m9IQUGGrzjwoD6t/executions/546>
- UI status: success; total duration was approximately 1.581 seconds.
- Observed path: `Manual Trigger -> Get User Data -> Get Todos -> Process Data -> Output Data`.
- Observed final output: one object item with `name = Leanne Graham`,
  `email = Sincere@april.biz`, `totalTodos = 20`, and
  `incompleteTodos = 9`.

#### What this passes

The workflow was generated and created, could be run in the n8n UI, and its
observed final output matched the requested one-item summary and values above.

#### What this does not claim

A single successful C07 execution does not establish that the model will
successfully generate every workflow. It also does not establish completion of
a multi-model comparison or isolated Code-sandbox validation.

## Conclusion

C01 to C04 all passed after iterative improvements. The primary lesson is that
fine-tuned model output must not be trusted as executable n8n configuration by
itself. The deployed n8n runtime is the authority for node types, versions, and
parameters.

The current architecture therefore uses the model for intent and workflow
generation, while deterministic runtime-schema validation controls whether a
workflow may be written to n8n. This approach reduces failures caused by old
training examples, changing n8n versions, and hallucinated node parameters.

Remaining limitations are execution-time concerns: credentials, external API
availability, resource IDs, and actual incoming data cannot be fully verified
until the workflow runs. Future testing should continue to record both
pre-creation validation outcomes and real execution outcomes.

## Next Test Entries

Append new cases below using the same structure:

### C05: Pending

- User request:
- Expected workflow:
- Create result:
- Execution result:
- Problems and resolution:
- Finding:
