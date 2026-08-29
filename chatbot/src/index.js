'use strict';

require('dotenv').config();

const dns = require('dns');
try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (_) {
  /* ignore */
}

const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('path');
const { Agent } = require('undici');

const OpenAI = require('openai');
const { processAgentMessage, verifyN8nApiKey } = require('./n8nAgent');
const { sanitizeCreateWorkflowPayload } = require('./workflowCreatePayload');
const { normalizeN8nBaseUrl, sanitizeProxyEnv } = require('./normalizeN8nBaseUrl');
const { normalizeAcceptanceContract } = require('./acceptanceContract');
const {
  buildCreateCandidateMessages,
  buildSemanticReviewerInput,
  createContractReady,
} = require('./createContractPrompt');

const { verifyCandidateWorkflow } = require('./candidateWorkflowVerifier');
const { runTimedStage, GenerateStageError } = require('./generateLifecycle');
const { evaluateShadowRepair } = require('./shadowRepairOrchestrator');
const { observeShadowRepair, shadowRepairEnabled } = require('./shadowObservation');
const { SUPPORTED_PATTERNS, compileBetaRequest } = require('./runtimeCompilerBeta');
const {
  enabledEnvironmentValue,
  planFirstAvailability,
} = require('./planFirstAvailability');
const {
  proposeNodewisePlan,
  approveNodewisePlan,
  compileApprovedNodewisePlan,
  reviewNodewisePlannerResult,
} = require('./approvedNodewiseCompiler');
const { requestNodewisePlannerResult } = require('./nodewisePlanner');
const {
  createCandidateLimit,
  evaluateCorrectnessFirstRepair,
  repairControllerLogPayload,
  decideCreateCandidateRetry,
} = require('./correctnessFirstRepair');
// HTTP(S)_PROXY with unbracketed IPv6 breaks Node fetch before the request URL is used.
sanitizeProxyEnv();

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({
  // Defer a missing cloud-key failure until a cloud route is actually used.
  // This also lets the route module load in offline test environments.
  apiKey: process.env.OPENAI_API_KEY || 'not-configured',
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  defaultHeaders: (process.env.OPENAI_BASE_URL && process.env.OLLAMA_BASIC_AUTH) ? {
    'Authorization': process.env.OLLAMA_BASIC_AUTH
  } : undefined
});

const openaiLocal = new OpenAI({
  apiKey: 'ollama-key',
  baseURL: process.env.OLLAMA_BASE_URL || undefined,
  defaultHeaders: process.env.OLLAMA_BASIC_AUTH ? {
    'Authorization': process.env.OLLAMA_BASIC_AUTH
  } : undefined
});
const N8N_BASE_URL = normalizeN8nBaseUrl(
  process.env.N8N_BASE_URL || 'http://localhost:5678'
);
const N8N_API_KEY = process.env.N8N_API_KEY;
const DIRECT_FETCH = new Agent({});

function parseModelList(value, fallback) {
  return [...new Set(String(value || fallback).split(',').map((m) => m.trim()).filter(Boolean))];
}

// Creation and canvas editing may use independently trained model families.
const CREATE_MODELS = parseModelList(process.env.CREATE_MODELS, process.env.CREATE_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5-coder-32b-ft-original:latest');
const EDIT_CLOUD_MODELS = parseModelList(process.env.EDIT_MODELS, process.env.EDIT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o');
// Keep gpt-oss selectable even on existing deployments whose older Compose
// file does not yet pass EDIT_OLLAMA_MODELS into the chatbot container.
const EDIT_OLLAMA_MODELS = parseModelList(process.env.EDIT_OLLAMA_MODELS, 'gpt-oss:120b');
const EDIT_MODELS = [...new Set([...EDIT_CLOUD_MODELS, ...EDIT_OLLAMA_MODELS])];
const DEFAULT_CREATE_MODEL = CREATE_MODELS[0];
const DEFAULT_EDIT_MODEL = EDIT_MODELS[0];
const SEMANTIC_REVIEW_ENABLED = !['0', 'false', 'no'].includes(
  String(process.env.SEMANTIC_REVIEW_ENABLED || 'true').toLowerCase()
);
const SEMANTIC_REVIEW_MODEL = process.env.SEMANTIC_REVIEW_MODEL || 'gpt-oss:120b';
const SEMANTIC_REVIEW_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.SEMANTIC_REVIEW_ATTEMPTS || '2', 10) || 2
);
const WORKFLOW_PLANNER_ENABLED = !['0', 'false', 'no'].includes(
  String(process.env.WORKFLOW_PLANNER_ENABLED || 'true').toLowerCase()
);
const WORKFLOW_PLANNER_MODEL = process.env.WORKFLOW_PLANNER_MODEL || 'gpt-oss:120b';
const SHADOW_REPAIR_ENABLED = shadowRepairEnabled(process.env.SHADOW_REPAIR_ENABLED);
const CORRECTNESS_FIRST_REPAIR_ENABLED = shadowRepairEnabled(process.env.CORRECTNESS_FIRST_REPAIR_ENABLED);
const RUNTIME_COMPILER_BETA_ENABLED = enabledEnvironmentValue(process.env.RUNTIME_COMPILER_BETA_ENABLED);
const BETA_CHAT_STANDALONE = enabledEnvironmentValue(process.env.BETA_CHAT_STANDALONE);
const PLAN_FIRST_COMPILER_ENABLED = enabledEnvironmentValue(process.env.PLAN_FIRST_COMPILER_ENABLED);
const PLANNER_APPROVAL_HMAC_SECRET = process.env.PLANNER_APPROVAL_HMAC_SECRET || '';
const PLAN_FIRST_PLANNER_MODEL = process.env.PLAN_FIRST_PLANNER_MODEL || 'qwen3.8:27b';

function timeoutMs(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const PLANNER_TIMEOUT_MS = timeoutMs('PLANNER_TIMEOUT_MS', 45000);
const CREATE_MODEL_TIMEOUT_MS = timeoutMs('CREATE_MODEL_TIMEOUT_MS', 120000);
const SEMANTIC_REVIEW_TIMEOUT_MS = timeoutMs('SEMANTIC_REVIEW_TIMEOUT_MS', 45000);
const STRUCTURAL_VALIDATION_TIMEOUT_MS = timeoutMs('STRUCTURAL_VALIDATION_TIMEOUT_MS', 45000);
const N8N_CREATE_TIMEOUT_MS = timeoutMs('N8N_CREATE_TIMEOUT_MS', 30000);
const POST_ACTION_VERIFICATION_TIMEOUT_MS = timeoutMs('POST_ACTION_VERIFICATION_TIMEOUT_MS', 30000);

function allowedModel(requested, allowed, fallback) {
  if (!requested) return fallback;
  return allowed.includes(requested) ? requested : null;
}

function editModelConfig(model) {
  if (EDIT_OLLAMA_MODELS.includes(model)) {
    return {
      model,
      apiKey: process.env.EDIT_OLLAMA_API_KEY || 'ollama-key',
      baseUrl: process.env.EDIT_OLLAMA_BASE_URL || 'http://140.115.54.62:11434/v1',
      basicAuth: process.env.EDIT_OLLAMA_BASIC_AUTH || process.env.OLLAMA_BASIC_AUTH || undefined,
    };
  }
  return { model };
}

function clientForModelConfig(modelConfig) {
  return new OpenAI({
    apiKey: modelConfig.apiKey || process.env.OPENAI_API_KEY,
    baseURL: modelConfig.baseUrl || process.env.OPENAI_BASE_URL || undefined,
    defaultHeaders: modelConfig.basicAuth ? {
      'Authorization': modelConfig.basicAuth,
    } : undefined,
  });
}

async function fetchWithRetry(url, options, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      const code = err && err.cause && err.cause.code ? String(err.cause.code) : '';
      if (i >= retries || !['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(code)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
}
async function verifyCreatedWorkflow(created, signal) {
  const createdId = created && created.id;
  const createdName = created && created.name;
  if (createdId === undefined || createdId === null || !String(createdId).trim()) {
    throw new Error('n8n create response did not include a workflow ID');
  }
  if (typeof createdName !== 'string' || !createdName.trim()) {
    throw new Error('n8n create response did not include a workflow name');
  }

  const workflowId = String(createdId);
  const response = await fetchWithRetry(`${N8N_BASE_URL}/api/v1/workflows/${encodeURIComponent(workflowId)}`, {
    headers: {
      'X-N8N-API-KEY': N8N_API_KEY,
      Connection: 'close',
    },
    dispatcher: DIRECT_FETCH,
    signal,
  }, 1);
  if (!response.ok) {
    throw new Error(`post-action workflow readback returned ${response.status}`);
  }
  const readback = await response.json();
  if (!readback || String(readback.id) !== workflowId) {
    throw new Error('post-action workflow readback ID does not match the create response');
  }
  if (readback.name !== createdName) {
    throw new Error('post-action workflow readback name does not match the create response');
  }
  if (!Array.isArray(readback.nodes) || !readback.nodes.every((node) => node && typeof node === 'object')) {
    throw new Error('post-action workflow readback has no valid nodes array');
  }
  if (!readback.connections || typeof readback.connections !== 'object' || Array.isArray(readback.connections)) {
    throw new Error('post-action workflow readback has no valid connections object');
  }
  return {
    status: 'pass',
    workflowId,
    workflowName: readback.name,
    nodeCount: readback.nodes.length,
    hasConnections: true,
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json({ limit: '12mb' }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Serve the browser-side widget script (injected into n8n via EXTERNAL_FRONTEND_HOOKS_URLS)
app.get('/widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'widget.js'));
});

// Serve the chat UI inside the iframe
const CHAT_HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8');

function modelConfig() {
  return {
    create: { models: CREATE_MODELS, defaultModel: DEFAULT_CREATE_MODEL },
    edit: { models: EDIT_MODELS, defaultModel: DEFAULT_EDIT_MODEL },
    compiler: { models: [], defaultModel: '' },
    compilerBeta: { enabled: RUNTIME_COMPILER_BETA_ENABLED, standalone: BETA_CHAT_STANDALONE, supportedPatterns: SUPPORTED_PATTERNS },
    planFirst: { enabled: planReviewEnabled(), plannerModel: PLAN_FIRST_PLANNER_MODEL },
  };
}

function renderChatHtml() {
  const config = JSON.stringify(modelConfig()).replace(/</g, '\\u003c');
  return CHAT_HTML_TEMPLATE.replace(
    '/* __N8N_WIDGET_MODEL_CONFIG__ */',
    `window.__N8N_WIDGET_MODEL_CONFIG__ = ${config};`,
  );
}

app.get('/chat', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(renderChatHtml());
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function sendModelConfig(req, res) {
  res.json(modelConfig());
}

app.get('/models', sendModelConfig);

async function createVerifiedCompilerWorkflow({ userRequest, candidateWorkflow, metadata = {} }) {
  try {
    const verification = await verifyCandidateWorkflow({
      operation: 'create', userRequest, candidateWorkflow,
    }, { n8nBaseUrl: N8N_BASE_URL, n8nApiKey: N8N_API_KEY });
    if (!['pass', 'warning'].includes(verification.status)) {
      return { status: 422, payload: { error: 'Runtime Compiler Beta workflow verification failed.', code: 'beta_static_verification_failed' } };
    }
    const n8nRes = await fetchWithRetry(`${N8N_BASE_URL}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': N8N_API_KEY, Connection: 'close' },
      body: JSON.stringify(sanitizeCreateWorkflowPayload(verification.workflow)), dispatcher: DIRECT_FETCH,
    }, 2);
    if (!n8nRes.ok) throw new Error(`n8n_create_failed_${n8nRes.status}`);
    const created = await n8nRes.json();
    const postActionVerification = await verifyCreatedWorkflow(created);
    return {
      status: 200,
      payload: {
        message: `Runtime Compiler Beta 已建立 workflow「${created.name}」。請在 n8n 手動執行並確認輸出。`,
        workflowId: created.id, workflowName: created.name,
        workflowUrl: `${process.env.N8N_PUBLIC_URL || 'http://localhost:5678'}/workflow/${created.id}`,
        workflow: created, postActionVerification, ...metadata,
      },
    };
  } catch (error) {
    console.error('[chatbot] runtime compiler beta failed:', error.message || error);
    return { status: 500, payload: { error: 'Runtime Compiler Beta could not create the workflow.', code: 'beta_create_failed' } };
  }
}

// The legacy beta accepts only named public-data patterns whose exact runtime
// JSON has been tested. The plan-first routes below use the same create adapter.
async function compileRuntimeBeta(message) {
  if (!RUNTIME_COMPILER_BETA_ENABLED) {
    return { status: 404, payload: { error: 'Runtime Compiler Beta is disabled.' } };
  }
  if (!message) return { status: 400, payload: { error: 'message is required' } };
  if (!N8N_API_KEY) {
    return { status: 503, payload: { error: 'Runtime Compiler Beta requires an n8n API key.' } };
  }

  const compiled = compileBetaRequest(message);
  if (compiled.status !== 'supported') {
    return {
      status: 422,
      payload: {
        error: '這個 Beta 目前只支援兩個已驗證的公開資料 pattern；不會改由模型猜測或建立 workflow。',
        code: 'beta_pattern_not_supported', supportedPatterns: compiled.supportedPatterns,
      },
    };
  }
  return createVerifiedCompilerWorkflow({
    userRequest: message,
    candidateWorkflow: compiled.workflow,
    metadata: { compilerPattern: compiled.pattern },
  });
}

app.post('/beta/compile', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const result = await compileRuntimeBeta(message);
  return res.status(result.status).json(result.payload);
});

function planReviewEnabled() {
  return planFirstAvailability({
    runtimeCompilerEnabled: RUNTIME_COMPILER_BETA_ENABLED,
    planFirstEnabled: PLAN_FIRST_COMPILER_ENABLED,
    secret: PLANNER_APPROVAL_HMAC_SECRET,
  }).available;
}

function planReviewUnavailable(res) {
  const availability = planFirstAvailability({
    runtimeCompilerEnabled: RUNTIME_COMPILER_BETA_ENABLED,
    planFirstEnabled: PLAN_FIRST_COMPILER_ENABLED,
    secret: PLANNER_APPROVAL_HMAC_SECRET,
  });
  if (availability.available) return false;
  res.status(availability.status).json({ error: availability.error });
  return true;
}

async function planFromUserRequest(message, previousSpecification, signal) {
  const plannerResult = await requestNodewisePlannerResult({
    client: openaiLocal,
    model: PLAN_FIRST_PLANNER_MODEL,
    userRequest: message,
    signal,
  });
  return reviewNodewisePlannerResult(plannerResult, { previousSpecification });
}

// Natural-language plan-first entrypoint. It deliberately stops at a rendered
// review; only an explicit approved-plan request can create a workflow.
async function handlePlanFromRequest(req, res) {
  if (planReviewUnavailable(res)) return;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  try {
    const review = await runTimedStage({
      stage: 'nodewise_planning',
      timeoutMs: PLANNER_TIMEOUT_MS,
      emit: () => {},
      task: (signal) => planFromUserRequest(message, req.body?.previousSpecification, signal),
    });
    if (review.outcome === 'clarification_required') {
      return res.json({ status: 'clarification_required', ...review });
    }
    if (review.outcome === 'unsupported_capability') {
      return res.json({ status: 'capability_gap', ...review });
    }
    return res.json({ status: 'review_required', ...review });
  } catch (error) {
    const timedOut = error instanceof GenerateStageError
      && error.stage === 'nodewise_planning'
      && /timed out/.test(error.message);
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? '規劃逾時，請稍後再試。' : 'Planner 無法產生可驗證的計畫。',
      code: timedOut ? 'plan_first_planner_timeout' : 'plan_first_planner_failed',
    });
  }
}

// Plan-first entrypoints. The client must explicitly call approve before it can
// call compile-approved; the approval token is bound to this exact specification,
// session, runtime schema revision, and skill registry revision.
app.post('/beta/plan-review', (req, res) => {
  if (planReviewUnavailable(res)) return;
  try {
    if (req.body?.plannerResult) {
      const review = reviewNodewisePlannerResult(req.body.plannerResult, {
        previousSpecification: req.body?.previousSpecification,
      });
      if (review.outcome === 'clarification_required') {
        return res.json({ status: 'clarification_required', ...review });
      }
      if (review.outcome === 'unsupported_capability') {
        return res.json({ status: 'capability_gap', ...review });
      }
      return res.json({ status: 'review_required', ...review });
    }
    const review = proposeNodewisePlan(req.body?.specification);
    return res.json({ status: 'review_required', ...review, planDiff: null });
  } catch (error) {
    return res.status(422).json({ error: error.message || 'Plan review failed.', code: 'plan_review_invalid' });
  }
});

function handlePlanApproval(req, res) {
  if (planReviewUnavailable(res)) return;
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (req.body?.approved !== true) return res.status(400).json({ error: 'Explicit approved:true is required.' });
  try {
    const approved = approveNodewisePlan(req.body?.specification, {
      secret: PLANNER_APPROVAL_HMAC_SECRET,
      sessionId,
    });
    return res.json({ status: 'approved', ...approved });
  } catch (error) {
    return res.status(422).json({ error: error.message || 'Plan approval failed.', code: 'plan_approval_invalid' });
  }
}

async function handleApprovedPlanCompilation(req, res) {
  if (planReviewUnavailable(res)) return;
  if (!N8N_API_KEY) return res.status(503).json({ error: 'Runtime Compiler Beta requires an n8n API key.' });
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  try {
    const compiled = compileApprovedNodewisePlan(req.body?.specification, req.body?.approvalToken, {
      secret: PLANNER_APPROVAL_HMAC_SECRET,
      sessionId,
    });
    const result = await createVerifiedCompilerWorkflow({
      userRequest: compiled.workflow.name,
      candidateWorkflow: compiled.workflow,
      metadata: {
        compilerMode: 'plan_first_nodewise',
        planFingerprint: compiled.planFingerprint,
        runtimeSchemaRevision: compiled.runtimeSchemaRevision,
        skillRegistryRevision: compiled.skillRegistryRevision,
      },
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return res.status(422).json({ error: error.message || 'Approved plan compilation failed.', code: 'approved_plan_rejected' });
  }
}

app.post('/beta/plan-from-request', handlePlanFromRequest);
app.post('/beta/plan-approve', handlePlanApproval);
app.post('/beta/compile-approved', handleApprovedPlanCompilation);

// ---------------------------------------------------------------------------
// POST /agent/run — intent decompose + modify/delete/insert station pipelines
// ---------------------------------------------------------------------------

app.post('/agent/run', async (req, res) => {
  const {
    message,
    sessionId,
    workflowId,
    clearSession,
    model,
  } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ ok: false, error: 'message is required' });
  }
  const selectedModel = allowedModel(model, EDIT_MODELS, DEFAULT_EDIT_MODEL);
  if (!selectedModel) {
    return res.status(400).json({ ok: false, error: '選擇的編輯模型不在伺服器允許清單中。' });
  }

  try {
    const out = await processAgentMessage({
      openai,
      n8nBaseUrl: N8N_BASE_URL,
      n8nApiKey: N8N_API_KEY,
      sessionId: sessionId || null,
      message: message.trim(),
      workflowId: workflowId || null,
      clearSession: !!clearSession,
      model: selectedModel,
      modelConfig: editModelConfig(selectedModel),
    });
    if (!out.ok) {
      return res.status(400).json(out);
    }
    return res.json(out);
  } catch (err) {
    console.error('agent/run error:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /generate — main AI endpoint
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert n8n workflow builder.
The user will describe a workflow in natural language. You must reply with ONLY a valid JSON object that represents an n8n workflow — no prose, no markdown fences, just the raw JSON.

Follow this schema exactly:

{
  "name": "<descriptive workflow name>",
  "nodes": [
    {
      "id": "<unique string id, e.g. uuid or short slug>",
      "name": "<Node Display Name>",
      "type": "<n8n node type, e.g. n8n-nodes-base.scheduleTrigger>",
      "typeVersion": <number>,
      "position": [<x>, <y>],
      "parameters": { <node-specific parameters> }
    }
  ],
  "connections": {
    "<Source Node Name>": {
      "main": [
        [{ "node": "<Target Node Name>", "type": "main", "index": 0 }]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}

Common node types and their typeVersion:
- n8n-nodes-base.manualTrigger (typeVersion 1) — manual start, no parameters
- n8n-nodes-base.scheduleTrigger (typeVersion 1.2) — IMPORTANT: "interval" MUST be an array (not an object). Example for daily at 9am:
    { "rule": { "interval": [ { "field": "days", "daysInterval": 1, "triggerAtHour": 9, "triggerAtMinute": 0 } ] } }
    Other interval options (always wrap the object in an array []):
    • Every N seconds:  [ { "field": "seconds", "secondsInterval": N } ]
    • Every N minutes:  [ { "field": "minutes", "minutesInterval": N } ]
    • Every N hours:    [ { "field": "hours", "hoursInterval": 1, "triggerAtMinute": 0 } ]
    • Daily at a time:  [ { "field": "days", "daysInterval": 1, "triggerAtHour": 9, "triggerAtMinute": 0 } ]
    • Weekly:           [ { "field": "weeks", "weeksInterval": 1, "triggerAtHour": 9, "triggerAtMinute": 0, "triggerAtDay": [1] } ]
    • Cron expression:  [ { "field": "cronExpression", "expression": "0 9 * * *" } ]
    CRITICAL: "interval" value is always an array [ {...} ], never a plain object { ... }.
- n8n-nodes-base.webhook (typeVersion 2) — parameters: { "httpMethod": "POST", "path": "my-path", "responseMode": "onReceived" }
- n8n-nodes-base.httpRequest (typeVersion 4.2) — parameters: { "method": "GET", "url": "https://..." }
- n8n-nodes-base.emailSend (typeVersion 2.1) — parameters: { "fromEmail": "...", "toEmail": "...", "subject": "...", "emailType": "text", "message": "..." }
- n8n-nodes-base.set (typeVersion 3.4) — parameters: { "mode": "manual", "assignments": { "assignments": [{ "id": "unique-id", "name": "key", "value": "value", "type": "string" }] } }
- n8n-nodes-base.if (typeVersion 2.2) — parameters: { "conditions": { "options": { "caseSensitive": true }, "conditions": [{ "leftValue": "={{ $json.field }}", "rightValue": "expected", "operator": { "type": "string", "operation": "equals" } }], "combinator": "and" } }
- n8n-nodes-base.code (typeVersion 1) — parameters: { "jsCode": "return items;" }
- n8n-nodes-base.noOp (typeVersion 1) — no parameters, use as placeholder
- @n8n/n8n-nodes-langchain.agent (typeVersion 2) — AI Agent that consumes AI language models and tools
- @n8n/n8n-nodes-langchain.lmChatOpenAi (typeVersion 1) — LLM node for AI chains
- n8n-nodes-base.googleSheetsTool (typeVersion 4.7) — Google Sheets tool for AI Agents
- @n8n/n8n-nodes-langchain.chainLlm (typeVersion 1.5) — basic LLM chain

Position nodes left-to-right, starting at [240, 300], each subsequent node +220 on the x axis.

Connection indexes are zero-based target-port positions. For a node with two
inputs, use index 0 for Input 1 and index 1 for Input 2. Never use an input
index that the target node does not expose.

Code-node runtime facts:
- The "items" variable contains the items arriving through the Code node's one main input.
- Do NOT use "$input.item(...)"; it is unavailable in this deployed runtime.
- To read a named earlier node, use "$('Exact Node Name').first().json" for one item or "$('Exact Node Name').all()" for all of its items.
- A named Code reference is valid only when that node must execute before the Code node on every trigger path. Graph reachability alone is not enough.
- An any-input node may run after any one incoming branch; sibling branches that both connect to it are not a synchronization boundary. Use a serial dependency or a runtime-verified all-required-inputs boundary when every referenced branch must be complete.
- Do not add a particular synchronization node merely to access an earlier node's output; choose the smallest runtime-valid topology that proves the required execution order.

Rules:
1. Every workflow must start with a trigger node (manualTrigger, scheduleTrigger, or webhook).
2. Build the smallest workflow that satisfies the user's request. Do not add nodes, credentials, HTTP calls, email steps, sticky notes, schedules, or explanations unless the user explicitly asks for them.
3. Every node MUST include a non-empty, unique "name". Node "id" values must also be unique.
4. Every connection source key and every connection "node" target MUST exactly match an existing node "name". Never reference a node that is not in "nodes".
5. Each connection output MUST use a two-dimensional array: "main": [[{ "node": "Target", "type": "main", "index": 0 }]]. Do not use a flat array of connection objects.
6. For an AI Agent, connect the LLM node to the agent with "ai_languageModel", and connect each tool node to the agent with "ai_tool". The connection "type" must match its output key.
7. Do not include JavaScript comments, trailing commas, placeholder nodes, or explanatory text in the JSON.
8. If the user explicitly names a node (for example, "Code node"), use that exact node type. Do not replace it with a similar node.
9. When a requested Code node creates or transforms static test data, make the Code node produce that data directly. Do not add a Set node merely as a data container.
10. Return ONLY the JSON — no explanation, no markdown.`;

const MAX_WORKFLOW_GENERATION_ATTEMPTS = 3;

function buildRegenerationInstruction(originalRequest, validationError) {
  return `Your previous workflow JSON was rejected by workflow verification.
Generate a fresh, smaller COMPLETE workflow from this original user request. Do not reuse, quote, or patch the previous answer.

Original user request:
${originalRequest}

Any node, application, or integration explicitly named in the original user request is a non-negotiable exact requirement. Include that exact requested component and do not replace it with a semantically similar node.

Verifier findings:
${validationError}

Before responding, verify every array item in "nodes" is a JSON object with id, name, type, typeVersion, position, and parameters. Put all node configuration inside "parameters". Use only nodes required by the user. Every type must be a real n8n node type, and every connection must reference an existing node. For conditional branches, use "main": [[...], [...]], never trueBranch or falseBranch. Do not emit comments, trailing commas, or escaped text outside JSON strings. Return raw JSON only.`;
}

const WORKFLOW_PLANNER_PROMPT = `You are the planning stage of an n8n workflow generator.
Turn a user's request into a concise, implementation-neutral workflow specification. You do not create n8n JSON and you do not invent private values.

Only ask for a value when it is impossible to safely guess and is required to create a meaningful workflow, such as a real email recipient, a private document or spreadsheet identifier, a credential choice, or a destination that changes the requested outcome. For ordinary optional details, choose a conservative default and record it as an assumption.

For every source needed by a final calculation or output, make the data-flow requirement explicit. A later computation may use a source on its direct input path or read it by the earlier node's exact name; do not assume unrelated node outputs are nested together.

Reply ONLY with this JSON object:
{
  "goal": "short description",
  "trigger": "how the workflow starts",
  "data_sources": [{ "name": "source", "required_fields": ["field"] }],
  "output_contract_required": false,
  "output_contract": {
    "required": false,
    "delivery_shape": "single_object_item",
    "item_count": 1,
    "fields": [{ "path": "fieldName", "required": true, "expected_type": "string" }]
  },
  "data_flow_requirements": ["facts that must be true for the workflow to work"],
  "assumptions": ["safe default selected for an omitted optional detail"],
  "required_user_inputs": [{ "question": "one necessary question", "reason": "why it cannot be guessed" }],
  "generator_instruction": "concise instruction describing the smallest valid workflow"
}

Set output_contract_required to true when the user explicitly requires final output fields, their types, a final item count, or a delivery shape. When true, output_contract must declare a single_object_item, item_count 1, and every required field with its exact canonical path, required true, and expected_type. Do not emit aliases for the same field. When false, use an empty fields array and do not invent an output schema.

For a request that can be created without private values, required_user_inputs must be an empty array. Do not mention node versions, do not write code, and do not include markdown.`;

const SEMANTIC_REVIEW_PROMPT = `You are a strict, read-only reviewer of an n8n workflow.
Compare the immutable acceptance contract and the supplied workflow JSON. The contract is authoritative for output fields, types, item count, and delivery shape; do not replace it with inferred aliases. The original request is context only. Do not rewrite the workflow and do not discuss credentials, external API availability, or execution results that cannot be known before running it.

Check only material request-to-workflow mismatches, including missing requested steps, wrong requested outputs, required data that never reaches a downstream step, and branches that do not implement the requested condition. A workflow is allowed to use optional inputs or a subset of a multi-input node when the user request does not require those inputs.

You will receive a static dataflow summary. A Code node may legally read data from an earlier node by exact name with $('Node Name').first(), .all(), .item(), or .itemMatching() only when the summary marks that node as existing and guaranteed to execute before the Code node. Graph reachability alone is not proof of execution order. Do not require direct connections, a particular intermediate node, or a particular implementation merely because multiple sources are read by Code. Do not claim a Code-node dataflow problem when the static summary verifies that must-execute-before dependency.

Your repair_instruction states the required outcome and data-flow constraint only. Never prescribe a particular n8n node, port number, Merge mode, or Code-node API. Never include example JavaScript. The workflow generator will choose a runtime-valid implementation.

Reply ONLY with this JSON object:
{
  "verdict": "pass" | "revise",
  "issues": [{
    "message": "short, concrete mismatch",
    "evidence": {
      "kind": "code_dataflow" | "workflow_structure" | "request_output" | "branch",
      "nodes": ["exact workflow node name"],
      "code_node": "required only for code_dataflow",
      "referenced_node": "required only for code_dataflow"
    }
  }],
  "repair_instruction": "A concise instruction for the workflow generator. Empty when verdict is pass."
}

Use "pass" only when the workflow satisfies the explicit user request. Use "revise" for a material mismatch. Do not request extra features the user did not ask for.`;

function extractJsonObject(rawText, errorMessage) {
  const candidates = [rawText.trim()];
  for (let start = rawText.indexOf('{'); start >= 0; start = rawText.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < rawText.length; index += 1) {
      const character = rawText[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(rawText.slice(start, index + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {
      // Keep scanning: gpt-oss may prefix a valid object with reasoning text.
    }
  }
  throw new Error(errorMessage);
}

function extractSemanticReviewObject(rawReview) {
  return extractJsonObject(rawReview, 'semantic reviewer returned invalid JSON');
}

function normalizeWorkflowPlan(rawPlan) {
  const plan = extractJsonObject(rawPlan, 'workflow planner returned invalid JSON');
  const stringList = (value) => Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
  const objects = (value) => Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object')
    : [];

  if (typeof plan.goal !== 'string' || !plan.goal.trim()) {
    throw new Error('workflow planner returned no goal');
  }
  if (typeof plan.generator_instruction !== 'string' || !plan.generator_instruction.trim()) {
    throw new Error('workflow planner returned no generator_instruction');
  }

  const outputContract = plan.output_contract && typeof plan.output_contract === 'object' && !Array.isArray(plan.output_contract)
    ? {
      required: plan.output_contract.required === true,
      delivery_shape: typeof plan.output_contract.delivery_shape === 'string' ? plan.output_contract.delivery_shape.trim() : '',
      item_count: Number.isInteger(plan.output_contract.item_count) ? plan.output_contract.item_count : null,
      fields: objects(plan.output_contract.fields),
    }
    : stringList(plan.output_contract);
  return {
    goal: plan.goal.trim(),
    trigger: typeof plan.trigger === 'string' ? plan.trigger.trim() : '',
    data_sources: objects(plan.data_sources),
    output_contract_required: plan.output_contract_required === true || outputContract?.required === true,
    output_contract: outputContract,
    data_flow_requirements: stringList(plan.data_flow_requirements),
    assumptions: stringList(plan.assumptions),
    required_user_inputs: objects(plan.required_user_inputs),
    generator_instruction: plan.generator_instruction.trim(),
  };
}

function normalizeSemanticReview(rawReview) {
  const review = extractSemanticReviewObject(rawReview);
  if (!review || typeof review !== 'object' || !['pass', 'revise'].includes(review.verdict)) {
    throw new Error('semantic reviewer must return verdict "pass" or "revise"');
  }
  const issues = Array.isArray(review.issues)
    ? review.issues.map((issue) => {
      if (typeof issue === 'string' && issue.trim()) {
        return { message: issue.trim(), evidence: null };
      }
      if (!issue || typeof issue !== 'object' || typeof issue.message !== 'string' || !issue.message.trim()) {
        return null;
      }
      const rawEvidence = issue.evidence;
      const evidence = rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)
        ? {
          kind: typeof rawEvidence.kind === 'string' ? rawEvidence.kind.trim() : '',
          nodes: Array.isArray(rawEvidence.nodes)
            ? rawEvidence.nodes.filter((node) => typeof node === 'string' && node.trim()).map((node) => node.trim())
            : [],
          code_node: typeof rawEvidence.code_node === 'string' ? rawEvidence.code_node.trim() : '',
          referenced_node: typeof rawEvidence.referenced_node === 'string' ? rawEvidence.referenced_node.trim() : '',
        }
        : null;
      return { message: issue.message.trim(), evidence };
    }).filter(Boolean)
    : [];
  const repairInstruction = typeof review.repair_instruction === 'string'
    ? review.repair_instruction.trim()
    : '';
  if (review.verdict === 'revise' && !repairInstruction) {
    throw new Error('semantic reviewer requested revision without a repair_instruction');
  }
  return { verdict: review.verdict, issues, repairInstruction };
}

async function reviewWorkflowSemantics(userRequest, acceptanceContract, workflow, dataflowSummary, signal) {
  const modelConfig = editModelConfig(SEMANTIC_REVIEW_MODEL);
  const reviewer = clientForModelConfig(modelConfig);
  let lastError;
  for (let attempt = 0; attempt < SEMANTIC_REVIEW_ATTEMPTS; attempt += 1) {
    let rawReview = '';
    try {
      const response = await reviewer.chat.completions.create({
        model: modelConfig.model,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: SEMANTIC_REVIEW_PROMPT },
          {
            role: 'user',
            content: buildSemanticReviewerInput({ userRequest, acceptanceContract, workflow, dataflowSummary }),
          },
        ],
      }, { signal });
      rawReview = response.choices[0]?.message?.content ?? '';
      return normalizeSemanticReview(rawReview);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      console.warn(
        `[chatbot] semantic reviewer attempt ${attempt + 1}/${SEMANTIC_REVIEW_ATTEMPTS} failed:`,
        error.message || String(error),
        rawReview ? `response preview: ${rawReview.slice(0, 300)}` : ''
      );
    }
  }
  throw new Error(`semantic reviewer unavailable: ${lastError?.message || String(lastError)}`);
}

async function planWorkflow(userRequest, signal) {
  const modelConfig = editModelConfig(WORKFLOW_PLANNER_MODEL);
  const planner = clientForModelConfig(modelConfig);
  const response = await planner.chat.completions.create({
    model: modelConfig.model,
    max_tokens: 1000,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: WORKFLOW_PLANNER_PROMPT },
      { role: 'user', content: userRequest },
    ],
  }, { signal });
  return normalizeWorkflowPlan(response.choices[0]?.message?.content ?? '');
}

app.post('/generate', async (req, res) => {
  const { message, model, stream, mode } = req.body || {};
  if (mode === 'plan_first_request') return handlePlanFromRequest(req, res);
  if (mode === 'plan_first_approve') return handlePlanApproval(req, res);
  if (mode === 'plan_first_compile') return handleApprovedPlanCompilation(req, res);
  if (mode === 'compiler_beta') {
    const compilerMessage = typeof message === 'string' ? message.trim() : '';
    const result = await compileRuntimeBeta(compilerMessage);
    return res.status(result.status).json(result.payload);
  }
  const streamProgress = stream === true;
  const lifecycleController = new AbortController();
  const { signal } = lifecycleController;

  function abortLifecycle() {
    if (!signal.aborted) lifecycleController.abort();
  }

  function onResponseClose() {
    if (!res.writableEnded) abortLifecycle();
  }

  function cleanupLifecycle() {
    req.removeListener('aborted', abortLifecycle);
    res.removeListener('close', onResponseClose);
  }

  req.once('aborted', abortLifecycle);
  res.once('close', onResponseClose);

  if (streamProgress) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  function progress(stage, messageText) {
    if (!streamProgress || res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify({ event: 'progress', stage, message: messageText })}\n`);
  }

  function lifecycleEvent(stage) {
    if (!streamProgress || res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify({ event: 'lifecycle', stage, timestamp: new Date().toISOString() })}\n`);
  }

  function respond(status, payload) {
    if (res.writableEnded || res.destroyed) {
      cleanupLifecycle();
      return undefined;
    }
    if (!streamProgress) {
      cleanupLifecycle();
      return res.status(status).json(payload);
    }
    res.write(`${JSON.stringify({ event: 'result', status, data: payload })}\n`);
    cleanupLifecycle();
    res.end();
    return undefined;
  }

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return respond(400, { error: 'message is required' });
  }
  const selectedModel = allowedModel(model, CREATE_MODELS, DEFAULT_CREATE_MODEL);
  if (!selectedModel) {
    return respond(400, { error: '選擇的建立模型不在伺服器允許清單中。' });
  }

  lifecycleEvent('request_received');
  progress('start', '正在分析需求並生成 workflow…');
  let workflowJson;
  let raw = '';
  try {
    let workflowPlan = null;
    let createAcceptanceContract = null;
    const shadowRepairHistory = [];
    const shadowStartedAt = Date.now();
    const correctnessFirstRepairHistory = [];
    let correctnessFirstContract = null;
    let correctnessFirstRepairPrompt = null;
    const generationCandidateLimit = createCandidateLimit(
      CORRECTNESS_FIRST_REPAIR_ENABLED,
      MAX_WORKFLOW_GENERATION_ATTEMPTS,
    );
    if (WORKFLOW_PLANNER_ENABLED) {
      progress('planning', `正在使用 ${WORKFLOW_PLANNER_MODEL} 整理資料來源與輸出需求…`);
      workflowPlan = await runTimedStage({
        stage: 'planning',
        timeoutMs: PLANNER_TIMEOUT_MS,
        signal,
        emit: lifecycleEvent,
        task: (stageSignal) => planWorkflow(message.trim(), stageSignal),
      });
      if (workflowPlan.required_user_inputs.length) {
        const questions = workflowPlan.required_user_inputs
          .map((item) => item.question)
          .filter((question) => typeof question === 'string' && question.trim());
        throw new Error(`workflow needs required user input before it can be created: ${questions.join(' ')}`);
      }
      createAcceptanceContract = normalizeAcceptanceContract({
        userRequest: message.trim(),
        plannerResult: workflowPlan,
        deliveryMode: 'candidate-only',
      });
      if (!createContractReady(createAcceptanceContract)) {
        throw new Error('workflow needs a complete typed output contract before it can be created');
      }
    }
    let verificationError = '';
    for (let attempt = 0; attempt < generationCandidateLimit; attempt += 1) {
      progress('generate', attempt === 0
        ? `正在使用 ${selectedModel} 生成 workflow…`
        : '正在依驗證結果重新生成 workflow…');
      const repairPrompt = attempt > 0
        ? (CORRECTNESS_FIRST_REPAIR_ENABLED && correctnessFirstRepairPrompt
          ? correctnessFirstRepairPrompt
          : buildRegenerationInstruction(message.trim(), verificationError))
        : null;
      const messages = buildCreateCandidateMessages({
        systemPrompt: SYSTEM_PROMPT,
        userRequest: message.trim(),
        acceptanceContract: createAcceptanceContract,
        repairPrompt,
      });

      const response = await runTimedStage({
        stage: 'generation',
        timeoutMs: CREATE_MODEL_TIMEOUT_MS,
        signal,
        emit: lifecycleEvent,
        task: (stageSignal) => openaiLocal.chat.completions.create({
          model: selectedModel,
          max_tokens: 4096,
          // JSON mode prevents comments, markdown, and other non-JSON tokens.
          response_format: { type: 'json_object' },
          temperature: attempt === 0
            ? (Number.parseFloat(process.env.OLLAMA_TEMPERATURE || '0') || 0)
            : (Number.parseFloat(process.env.OLLAMA_RETRY_TEMPERATURE || '0.2') || 0.2),
          messages,
        }, { signal: stageSignal }),
      });

      raw = response.choices[0]?.message?.content ?? '';
      progress('structural_validation', '正在檢查節點、參數與連線格式…');
      const verification = await runTimedStage({
        stage: 'structural_validation',
        timeoutMs: STRUCTURAL_VALIDATION_TIMEOUT_MS,
        signal,
        emit: lifecycleEvent,
        task: (verificationSignal) => verifyCandidateWorkflow({
          operation: 'create',
          userRequest: message.trim(),
          candidateWorkflow: raw,
          acceptanceContract: createAcceptanceContract || (workflowPlan
            ? { requiredUserInputs: workflowPlan.required_user_inputs }
            : undefined),
        }, {
          n8nBaseUrl: N8N_BASE_URL,
          n8nApiKey: N8N_API_KEY,
          semanticReview: SEMANTIC_REVIEW_ENABLED ? async (context) => {
            progress('semantic_review', `正在使用 ${SEMANTIC_REVIEW_MODEL} 檢查流程是否符合需求…`);
            return runTimedStage({
              stage: 'semantic_review',
              timeoutMs: SEMANTIC_REVIEW_TIMEOUT_MS,
              signal: verificationSignal,
              emit: lifecycleEvent,
              task: (stageSignal) => reviewWorkflowSemantics(
                context.userRequest,
                context.acceptanceContract || createAcceptanceContract,
                context.workflow,
                context.dataflowSummary,
                stageSignal,
              ),
            });
          } : undefined,
        }),
      });

      if (SHADOW_REPAIR_ENABLED) {
        // Fire-and-forget by design: this observer cannot alter verification,
        // regeneration, stream events, n8n I/O, or the HTTP response.
        void observeShadowRepair({
          enabled: true,
          evaluateShadowRepair,
          operation: 'create',
          userRequest: message.trim(),
          plannerOutput: workflowPlan || {},
          candidateWorkflow: verification.workflow || raw,
          verificationResult: verification,
          repairState: {
            history: shadowRepairHistory,
            elapsedMs: Math.max(0, Date.now() - shadowStartedAt),
          },
          now: Date.now(),
        }).then((observation) => {
          const summary = observation?.report?.summary;
          if (!summary) return;
          shadowRepairHistory.push({
            behaviorFingerprint: summary.candidateBehaviorFingerprint,
            blockingFindingFingerprints: summary.blockingFindingFingerprints,
            severity: summary.severity,
            contractCoverage: summary.contractCoverage,
          });
        });
      }

      for (const warning of verification.warnings) {
        console.warn('[chatbot] workflow verification warning:', warning);
      }
      if (verification.status === 'repair' || verification.status === 'clarify') {
        const semantic = verification.verification.semantic;
        const feedbackFindings = [
          ...verification.errors,
          ...verification.warnings.map((warning) => `Verifier normalization: ${warning}`),
        ];
        verificationError = semantic && semantic.status === 'repair'
          ? [
            'Semantic review found that the workflow does not fully satisfy the original request.',
            ...feedbackFindings.map((issue) => `- ${issue}`),
            `Required repair: ${semantic.repairInstruction || 'Regenerate the workflow to satisfy the request.'}`,
          ].join('\n')
          : feedbackFindings.join('; ');

        const retryDecision = await decideCreateCandidateRetry({
          correctnessFirstEnabled: CORRECTNESS_FIRST_REPAIR_ENABLED,
          attempt,
          legacyMaxCandidates: MAX_WORKFLOW_GENERATION_ATTEMPTS,
          evaluateCorrectnessFirstRepair,
          controllerInput: {
            evaluateShadowRepair,
            operation: 'create',
            userRequest: message.trim(),
            plannerOutput: workflowPlan || {},
            candidateWorkflow: verification.workflow || raw,
            verificationResult: verification,
            existingContract: correctnessFirstContract || createAcceptanceContract,
            repairState: {
              history: correctnessFirstRepairHistory,
              elapsedMs: Math.max(0, Date.now() - shadowStartedAt),
            },
            now: Date.now(),
          },
        });
        const controller = retryDecision.controller;
        if (controller?.action === 'fallback') {
          console.warn('[chatbot] repair_controller_warning', {
            event: 'repair_controller_warning', operation: 'create', reason: 'evaluation_failed', timestamp: new Date().toISOString(),
          });
        } else if (controller?.report) {
          console.info('[chatbot] repair_controller_decision', repairControllerLogPayload({
            operation: 'create', report: controller.report, timestamp: new Date().toISOString(),
          }));
          correctnessFirstContract = controller.report.contract;
          correctnessFirstRepairHistory.push({
            behaviorFingerprint: controller.report.summary.candidateBehaviorFingerprint,
            blockingFindingFingerprints: controller.report.summary.blockingFindingFingerprints,
            severity: controller.report.summary.severity,
            contractCoverage: controller.report.summary.contractCoverage,
          });
        }
        if (retryDecision.action === 'retry') {
          correctnessFirstRepairPrompt = retryDecision.repairPrompt;
          if (!CORRECTNESS_FIRST_REPAIR_ENABLED || controller?.action === 'fallback') {
            console.warn('[chatbot] workflow verification requested one regeneration:', verificationError);
          }
          progress('regenerate', '驗證發現問題，正在要求模型修正…');
          continue;
        }
        throw new Error(`workflow verification failed: ${verificationError}`);
      }
      workflowJson = verification.workflow;
      break;
    }
  } catch (err) {
    lifecycleEvent('failed');
    console.error('Claude error:', err);
    console.error('Raw LLM output was:', raw);
    return respond(500, { error: `AI generation failed: ${err.message}` });
  }

  if (!N8N_API_KEY) {
    progress('complete', 'Workflow 已生成，尚未設定 n8n API，因此未寫入畫布。');
    lifecycleEvent('completed');
    return respond(200, {
      message: 'Workflow generated (not injected — N8N_API_KEY not set)',
      workflow: workflowJson,
    });
  }

  try {
    progress('create_workflow', '正在建立 n8n workflow…');
    const created = await runTimedStage({
      stage: 'n8n_create',
      timeoutMs: N8N_CREATE_TIMEOUT_MS,
      signal,
      emit: lifecycleEvent,
      task: async (stageSignal) => {
        const cleanedWf = sanitizeCreateWorkflowPayload(workflowJson);
        if (signal.aborted || stageSignal.aborted) {
          throw new GenerateStageError('n8n_create', 'generation cancelled before n8n_create');
        }
        const n8nRes = await fetchWithRetry(`${N8N_BASE_URL}/api/v1/workflows`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-N8N-API-KEY': N8N_API_KEY,
            Connection: 'close',
          },
          body: JSON.stringify(cleanedWf),
          dispatcher: DIRECT_FETCH,
          signal: stageSignal,
        }, 2);

        if (!n8nRes.ok) {
          const errText = await n8nRes.text();
          throw new Error(`n8n API returned ${n8nRes.status}: ${errText}`);
        }
        return n8nRes.json();
      },
    });
    progress('post_action_verification', '正在確認已建立的 workflow…');
    const postActionVerification = await runTimedStage({
      stage: 'post_action_verification',
      timeoutMs: POST_ACTION_VERIFICATION_TIMEOUT_MS,
      signal,
      emit: lifecycleEvent,
      task: (stageSignal) => verifyCreatedWorkflow(created, stageSignal),
    });
    console.info('[chatbot] post-action workflow verification passed:', {
      workflowId: postActionVerification.workflowId,
      workflowName: postActionVerification.workflowName,
      nodeCount: postActionVerification.nodeCount,
    });
    progress('complete', 'Workflow 已建立，正在更新畫布…');
    lifecycleEvent('completed');
    return respond(200, {
      message: `好的，已為你建立 workflow「${created.name}」。`,
      workflowId: created.id,
      workflowName: created.name,
      workflowUrl: `${process.env.N8N_PUBLIC_URL || 'http://localhost:5678'}/workflow/${created.id}`,
      workflow: created,
      postActionVerification,
    });
  } catch (err) {
    lifecycleEvent('failed');
    console.error('n8n inject error:', err);
    return respond(500, {
      error: `n8n injection failed: ${err.message}`,
      workflow: workflowJson,
    });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function startServer() {
  return app.listen(port, () => {
  console.log(`n8n AI widget server running on http://localhost:${port}`);
  console.log(`n8n API base: ${N8N_BASE_URL}`);
  void verifyN8nApiKey(N8N_BASE_URL, N8N_API_KEY).then((check) => {
    if (!N8N_API_KEY) {
      console.warn('[chatbot] N8N_API_KEY 未設定 — agent 無法讀寫 workflow');
      return;
    }
    if (check.ok) {
      console.log('[chatbot] N8N_API_KEY verified');
      return;
    }
    if (check.reason === 'unauthorized') {
      console.error(
        '[chatbot] N8N_API_KEY 無效（401）。請在 n8n → Settings → n8n API 建立新 key，' +
          '更新 .env 後執行：docker compose --env-file .env up -d --force-recreate chatbot'
      );
      return;
    }
    console.warn('[chatbot] N8N_API_KEY check failed:', check);
  });
  });
}

// Node's test runner executes source files supplied via `node --test src` as
// child test workers. They must be importable without binding an HTTP port.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) startServer();

module.exports = { app, startServer };
