'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const { aggregatePilotReport, ensureSafeReport, runCreateModelPilot } = require('./runCreateModelPilot');
const { emitSafeSummary, writeSanitizedArtifact } = require('./pilotArtifactTelemetry');
const { safeStructuredFinding } = require('./safeStaticFindingSummary');

const CANDIDATE = Object.freeze({ slot: 'candidate_a', modelTag: 'qwen2.5-coder-32b-ft-original:latest' });
const TIMEOUT_MS = 120000;
const REPEATS = 3;
const STOP_AFTER_AVAILABILITY_FAILURES = 2;
const DECODING_FINGERPRINT_INPUT = 'response_format=json_object|max_tokens=4096|temperature=0';
const PROMPT_TEMPLATE = 'create-static-pilot-v1: Return one n8n workflow JSON object only. Respect the supplied acceptance contract, allowed node types, allowed URLs, and expected delivery state. Do not include credentials, webhooks, schedules, or workflow execution.';

const CASES = Object.freeze([
  {
    caseId: 'C01',
    userRequest: 'Retrieve a single public JSONPlaceholder post and return its id and title.',
    acceptanceContract: { contractRevision: 1, expectedDeliveryState: 'ready-to-run', executionAssertions: [{ path: 'id', required: true, expectedType: 'number' }, { path: 'title', required: true, expectedType: 'string' }] },
    allowedNodeTypes: ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.set'],
    allowedUrls: ['https://jsonplaceholder.typicode.com/posts/1'],
    expectedDeliveryState: 'ready-to-run',
    executionEvidencePolicy: 'safe_execution_assertion',
  },
  {
    caseId: 'C04',
    userRequest: 'Retrieve a public JSONPlaceholder user and return the name and username.',
    acceptanceContract: { contractRevision: 1, expectedDeliveryState: 'ready-to-run', executionAssertions: [{ path: 'name', required: true, expectedType: 'string' }, { path: 'username', required: true, expectedType: 'string' }] },
    allowedNodeTypes: ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code', 'n8n-nodes-base.set'],
    allowedUrls: ['https://jsonplaceholder.typicode.com/users/1'],
    expectedDeliveryState: 'ready-to-run',
    executionEvidencePolicy: 'skipped_or_manual_or_sandbox_evidence',
  },
  {
    caseId: 'C07',
    userRequest: 'Retrieve public JSONPlaceholder user and todo data, then return a todo summary.',
    acceptanceContract: { contractRevision: 1, expectedDeliveryState: 'ready-to-run', executionAssertions: [{ path: 'name', required: true, expectedType: 'string' }, { path: 'email', required: true, expectedType: 'string' }, { path: 'total_todos', required: true, expectedType: 'number', equals: 20 }, { path: 'incomplete_todos', required: true, expectedType: 'number', equals: 9 }] },
    allowedNodeTypes: ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code', 'n8n-nodes-base.set'],
    allowedUrls: ['https://jsonplaceholder.typicode.com/users/1', 'https://jsonplaceholder.typicode.com/todos?userId=1'],
    expectedDeliveryState: 'ready-to-run',
    executionEvidencePolicy: 'skipped_or_manual_or_sandbox_evidence',
  },
]);

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceRoot() {
  return process.env.PILOT_SOURCE_ROOT || process.cwd();
}

function snapshotFingerprint(root = sourceRoot()) {
  return fingerprint(fs.readFileSync(path.join(root, 'schemas', 'runtime_node_schemas.json')));
}

function promptFor(testCase) {
  return [
    PROMPT_TEMPLATE,
    `User request: ${testCase.userRequest}`,
    `Acceptance contract: ${JSON.stringify(testCase.acceptanceContract)}`,
    `Allowed node types: ${JSON.stringify(testCase.allowedNodeTypes)}`,
    `Allowed URLs: ${JSON.stringify(testCase.allowedUrls)}`,
    `Expected delivery state: ${testCase.expectedDeliveryState}`,
  ].join('\n');
}

function safeHttpFailure(response) {
  return { kind: 'http_failure', httpStatus: response.status, contentType: response.headers.get('content-type') || undefined, telemetry: { requestDispatchStarted: true, responseReceived: true, httpStatus: response.status, contentType: response.headers.get('content-type') || undefined } };
}

function createGenerate({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  return async ({ candidate, request, acceptanceContract, testCase, timeoutMs }) => {
    if (candidate?.slot !== CANDIDATE.slot || candidate?.modelTag !== CANDIDATE.modelTag) throw { kind: 'route_unconfigured' };
    const baseUrl = typeof env.OLLAMA_BASE_URL === 'string' ? env.OLLAMA_BASE_URL.trim() : '';
    if (!baseUrl) throw { kind: 'route_unconfigured' };
    let requestDispatchStarted = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (env.OLLAMA_BASIC_AUTH) headers.authorization = env.OLLAMA_BASIC_AUTH;
      requestDispatchStarted = true;
      const response = await fetchImpl(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: candidate.modelTag,
          max_tokens: 4096,
          response_format: { type: 'json_object' },
          temperature: 0,
          messages: [{ role: 'system', content: PROMPT_TEMPLATE }, { role: 'user', content: testCase ? promptFor(testCase) : String(request || '') }, { role: 'user', content: 'Acceptance contract: ' + JSON.stringify(acceptanceContract || {}) }],
        }),
      });
      if (!response.ok) throw safeHttpFailure(response);
      const payload = await response.json();
      return {
        httpStatus: response.status,
        contentType: response.headers.get('content-type') || undefined,
        rawOutput: payload?.choices?.[0]?.message?.content ?? '',
        candidateCount: 1,
        telemetry: { requestDispatchStarted: true, responseReceived: true, httpStatus: response.status, contentType: response.headers.get('content-type') || undefined },
      };
    } catch (error) {
      const telemetry = error?.telemetry || { requestDispatchStarted, responseReceived: false, httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null, contentType: error?.contentType };
      if (error?.name === 'AbortError') throw { kind: 'timeout', telemetry };
      if (error?.kind) throw { ...error, telemetry };
      throw { kind: 'transport', telemetry };
    } finally {
      clearTimeout(timer);
    }
  };
}

function createStaticVerifier({ root = sourceRoot(), verifier, spawn = spawnSync } = {}) {
  const verifyCandidateWorkflow = verifier || require(path.join(root, 'src', 'candidateWorkflowVerifier')).verifyCandidateWorkflow;
  return async ({ candidate, testCase }) => {
    let childTelemetry = { childSpawnStatus: 'not_observed', childExitCode: null, childSignal: null, stderrPresent: false };
    const structuralValidator = (input) => {
      const rawCandidate = typeof input.candidateWorkflow === 'string' ? input.candidateWorkflow : JSON.stringify(input.candidateWorkflow);
      const child = spawn(process.env.PYTHON_BIN || 'python3', [path.join(root, 'python', 'workflow_repair.py')], { input: JSON.stringify({ raw_output: rawCandidate, n8n_url: undefined, api_key: undefined, user_request: input.userRequest, benchmarkStaticProtocol: true }), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 48 * 1024 * 1024 });
      childTelemetry = { childSpawnStatus: child.error ? 'spawn_failure' : 'spawned', childExitCode: Number.isInteger(child.status) ? child.status : null, childSignal: typeof child.signal === 'string' ? child.signal : null, stderrPresent: Boolean(child.stderr && String(child.stderr).trim()) };
      if (child.error) throw Object.assign(new Error('benchmark static verifier spawn failed'), { childTelemetry });
      let parsed;
      try { parsed = JSON.parse(String(child.stdout || '').trim()); } catch { throw Object.assign(new Error('benchmark static verifier returned invalid envelope'), { childTelemetry }); }
      const protocolEnvelope = typeof parsed?.ok === 'boolean'
        && Array.isArray(parsed?.findings)
        && typeof parsed?.unstructuredFailure === 'boolean';
      const findings = protocolEnvelope ? parsed.findings.map(safeStructuredFinding).filter(Boolean) : [];
      if (!protocolEnvelope || !parsed.ok || child.status !== 0) {
        const error = Object.assign(new Error('benchmark static verifier failed'), { childTelemetry });
        if (findings.length) error.findings = findings;
        throw error;
      }
      return { workflow: input.candidateWorkflow, warnings: [], repairs: {}, findings };
    };
    try {
      const result = await verifyCandidateWorkflow({ operation: 'create', userRequest: testCase.userRequest, candidateWorkflow: candidate, acceptanceContract: testCase.acceptanceContract }, { n8nBaseUrl: undefined, n8nApiKey: undefined, structuralValidator });
      return { result, childTelemetry };
    } catch (error) {
      throw { kind: 'static_verifier_failure', childTelemetry: error?.childTelemetry || childTelemetry };
    }
  };
}

async function runCandidateAStaticPilot({ generate, verifyStatic, root = sourceRoot(), now } = {}) {
  const pilot = await runCreateModelPilot({
    candidates: [CANDIDATE],
    cases: CASES,
    repeats: REPEATS,
    timeoutMs: TIMEOUT_MS,
    stopAfterConsecutiveAvailabilityFailures: STOP_AFTER_AVAILABILITY_FAILURES,
    generate: generate || createGenerate(),
    verifyStatic: verifyStatic || createStaticVerifier({ root }),
    now,
  });
  const report = {
    schemaVersion: '1.0',
    kind: 'candidate_a_create_static_pilot_baseline',
    candidateSlot: CANDIDATE.slot,
    modelTag: CANDIDATE.modelTag,
    promptTemplateFingerprint: fingerprint(PROMPT_TEMPLATE),
    runtimeSchemaSnapshotFingerprint: snapshotFingerprint(root),
    decodingFingerprint: fingerprint(DECODING_FINGERPRINT_INPUT),
    semanticReviewStatus: 'not_run',
    pilot,
    aggregate: aggregatePilotReport(pilot),
  };
  if (!ensureSafeReport(report)) throw new Error('safe pilot report invariant failed');
  return report;
}

function defaultArtifactPath(root) {
  return path.join(root, 'tests', 'modelBenchmark', 'results', 'candidate-a-static-pilot-latest.json');
}

async function runAndPersistCandidateAStaticPilot({ artifactPath, stdout, writeArtifact = writeSanitizedArtifact, emitSummary = emitSafeSummary, ...options } = {}) {
  let terminal;
  try {
    const report = await runCandidateAStaticPilot(options);
    terminal = { ...report, terminalStatus: report.aggregate.status, stdoutWriteStatus: 'not_attempted' };
  } catch (error) {
    terminal = {
      schemaVersion: '1.1',
      kind: 'candidate_a_create_static_pilot_baseline',
      terminalStatus: 'incomplete',
      failureCategory: error?.kind || 'local_setup_failure',
      semanticReviewStatus: 'not_run',
      pilot: { terminalStatus: 'incomplete', plannedRuns: 0, incomplete: true, records: [] },
      aggregate: { status: 'incomplete', totalRuns: 0, attemptedRuns: 0, completedRuns: 0, incompleteRuns: 0, availabilityFailureCount: 0, semanticReviewStatus: 'not_run', perCase: [] },
      stdoutWriteStatus: 'not_attempted',
    };
  } finally {
    const summary = {
      kind: 'candidate_a_create_static_pilot_summary',
      terminalStatus: terminal?.terminalStatus || 'incomplete',
      attemptedRuns: terminal?.aggregate?.attemptedRuns || 0,
      completedRuns: terminal?.aggregate?.completedRuns || 0,
      availabilityFailureCount: terminal?.aggregate?.availabilityFailureCount || 0,
    };
    terminal.stdoutWriteStatus = emitSummary({ stdout, summary });
    const persisted = writeArtifact({ artifactPath: artifactPath || defaultArtifactPath(options.root || sourceRoot()), report: terminal });
    terminal.artifactTelemetry = persisted.telemetry;
    Object.assign(terminal, persisted.telemetry);
    terminal.artifactPath = persisted.artifactPath;
  }
  return terminal;
}

async function main() {
  await runAndPersistCandidateAStaticPilot({ artifactPath: process.env.PILOT_ARTIFACT_PATH || undefined });
}

if (require.main === module || process.env.PILOT_RUN_MAIN === '1') main().catch(() => { process.exitCode = 1; });

module.exports = { CASES, CANDIDATE, createGenerate, createStaticVerifier, defaultArtifactPath, promptFor, runAndPersistCandidateAStaticPilot, runCandidateAStaticPilot };
