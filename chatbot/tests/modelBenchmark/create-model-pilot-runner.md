# Create model pilot runner

`runCreateModelPilot.js` is an injected-client benchmark harness. It has no
n8n client, does not create workflows, and does not write reports itself. The
caller supplies a model generator and a static verifier; raw prompts, model
output, and workflow JSON remain in memory only and are excluded from the
returned JSON report.

The planned pilot uses these deployed tags without assigning historical
fine-tune labels:

- `candidate_a`: `qwen2.5-coder-32b-ft-original:latest`
- `candidate_b`: `qwen_n8n_v3:latest`
- `candidate_c`: `gemma4:31b`

The complete pilot is 3 candidates × 3 cases (C01/C04/C07) × 3 repeats = 27
generation calls. Each call uses the manifest timeout of 120 seconds. Before
that run, one readiness call per candidate may use the fixed Manual Trigger
only request; readiness establishes only HTTP/latency/JSON availability, not
workflow correctness or inference quality.

JSON handling mirrors the Create extractor: strict JSON parses the complete raw
response as one JSON object; repaired JSON scans the same balanced object
candidates that Create uses for markdown fences or prose prefixes. Reports keep
`strictJsonStatus` and `repairedJsonStatus` separate. A repaired result is only
ready for static verification when it has the basic workflow envelope (`nodes`
array and `connections` object); it must still pass the same static verifier.
Non-workflow JSON remains repaired-fail.

Only a readiness strict pass or repaired-json-ready candidate may enter the
full pilot. Timeout, route/configuration, auth, model-not-found, SDK, transport,
or unclassified-client-response availability failures are ineligible; this runner never repairs
routes or settings.

Persist a returned report only after review, under
`chatbot/tests/modelBenchmark/results/`, using a non-sensitive run ID. Do not
store raw requests, workflow output, workflow IDs, hosts, endpoints,
credentials, or error bodies. C01 has `executionEvidenceStatus=not_run` in
this static pilot; C04/C07 must remain `skipped` unless separately supported by
manual or isolated-sandbox evidence.

## Telemetry and artifact contract

Each attempted generation has a terminal record, formed in a `finally` path. It
contains only de-identified fields: `invocationStartedAt`,
`invocationFinishedAt`, `terminalStatus`, request-dispatch/response booleans,
HTTP status (or `null`), a safe content-type category, timeout state, and an
availability failure category. Static verification records
`childSpawnStatus`, `childExitCode`, `childSignal`, and `stderrPresent`; it
never stores stderr content.

A pilot aggregate is `complete`, `partial_availability`, or `incomplete`.
Completed runs remain in an artifact when other attempts receive HTTP failures.
The runner writes a sanitized JSON artifact through a temporary file followed
by atomic rename. Its terminal telemetry records write start/finish, rename
status, and only a categorical write failure. Stdout is a compact safe summary,
not the artifact or workflow content.

`summarizeCandidateABaseline.js` is read-only. For the existing candidate_a
baseline it reports: attempted `9`, completed `5`, HTTP failures `4`, and
strict/repaired JSON `5/9` each.

## Container observation and host copy

The bounded-pilot outer wrapper must retain only `docker exec` exit code,
signal, stdout/stderr presence booleans, and outer-timeout status. After that
command returns, it observes the expected final container artifact path before
copying it to the host results directory. Observation first checks an
immediately visible JSON artifact and terminal envelope, then performs a
bounded fixed-interval poll for a delayed writer.

An artifact with a terminal envelope is copied even if `docker exec` returned
nonzero; that condition is reported as `artifact_available_exec_nonzero`, not
silently discarded. Missing, unparseable, terminal-envelope-missing, and copy
failures are separate categories. The wrapper does not retain command stdout,
stderr, prompt text, model output, workflow JSON, IDs, URLs, or credentials.

## Safe static-finding summary

Static-verifier findings are reduced to fixed compatibility classes only:
`node_type`, `type_version`, `parameter_schema`, `parameter_value`,
`connection_port`, `connection_shape`, `code_dataflow`,
`unsupported_metadata`, `payload_sanitization`, and `unknown_structural`.
Each bucket records a count, normalized severity (`warning`, `repair`, or
`fail`), deterministic-normalization status, and blocking count/status. Rule
IDs, messages, locations, node names, IDs, positions, parameters, URLs, and
workflow content are deliberately excluded from this benchmark report layer.

Baseline summaries calculate JSON rates over attempted runs and static,
repairable, and blocking rates only over completed runs. Legacy artifacts are
summarized from their existing aggregate rule counts without reconstructing a
workflow.

## Structured-finding boundary

The benchmark static adapter accepts child-process findings only when their
already-structured `ruleId`, category, or location kind directly maps to a
fixed safe class. It projects accepted findings to a fixed benchmark rule and
drops message and location fields before calling the shared verifier. A child
error with no structured findings remains `unknown_structural`; the adapter
never parses its error text, workflow content, or node labels to infer a class.
