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
const path = require('path');
const { spawnSync } = require('child_process');
const { Agent } = require('undici');

const PYTHON = process.env.PYTHON_BIN || 'python3';
const REPAIR_SCRIPT = path.join(__dirname, '..', 'python', 'workflow_repair.py');
const OpenAI = require('openai');
const { processAgentMessage, verifyN8nApiKey, stripWorkflowPayload } = require('./n8nAgent');
const { normalizeN8nBaseUrl, sanitizeProxyEnv } = require('./normalizeN8nBaseUrl');

// HTTP(S)_PROXY with unbracketed IPv6 breaks Node fetch before the request URL is used.
sanitizeProxyEnv();

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
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
app.get('/chat', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'chat.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// POST /agent/run — intent decompose + modify/delete/insert station pipelines
// ---------------------------------------------------------------------------

app.post('/agent/run', async (req, res) => {
  const {
    message,
    sessionId,
    workflowId,
    clearSession,
  } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ ok: false, error: 'message is required' });
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
- n8n-nodes-base.set (typeVersion 3.4) — parameters: { "mode": "manual", "fields": { "values": [{ "name": "key", "type": "stringValue", "string": "value" }] } }
- n8n-nodes-base.if (typeVersion 2.2) — parameters: { "conditions": { "options": { "caseSensitive": true }, "conditions": [{ "leftValue": "={{ $json.field }}", "rightValue": "expected", "operator": { "type": "string", "operation": "equals" } }], "combinator": "and" } }
- n8n-nodes-base.code (typeVersion 2) — parameters: { "jsCode": "return items;" }
- n8n-nodes-base.noOp (typeVersion 1) — no parameters, use as placeholder
- @n8n/n8n-nodes-langchain.agent (typeVersion 2) — AI Agent that consumes AI language models and tools
- @n8n/n8n-nodes-langchain.lmChatOpenAi (typeVersion 1) — LLM node for AI chains
- n8n-nodes-base.googleSheetsTool (typeVersion 4.7) — Google Sheets tool for AI Agents
- @n8n/n8n-nodes-langchain.chainLlm (typeVersion 1.5) — basic LLM chain

Position nodes left-to-right, starting at [240, 300], each subsequent node +220 on the x axis.

Rules:
1. Every workflow must start with a trigger node (manualTrigger, scheduleTrigger, or webhook).
2. Build the smallest workflow that satisfies the user's request. Do not add nodes, credentials, HTTP calls, email steps, sticky notes, schedules, or explanations unless the user explicitly asks for them.
3. Every node MUST include a non-empty, unique "name". Node "id" values must also be unique.
4. Every connection source key and every connection "node" target MUST exactly match an existing node "name". Never reference a node that is not in "nodes".
5. Each connection output MUST use a two-dimensional array: "main": [[{ "node": "Target", "type": "main", "index": 0 }]]. Do not use a flat array of connection objects.
6. For an AI Agent, connect the LLM node to the agent with "ai_languageModel", and connect each tool node to the agent with "ai_tool". The connection "type" must match its output key.
7. Do not include JavaScript comments, trailing commas, placeholder nodes, or explanatory text in the JSON.
8. Return ONLY the JSON — no explanation, no markdown.`;

const MAX_WORKFLOW_GENERATION_ATTEMPTS = 2;

function repairWorkflowOutput(raw) {
  const repairRes = spawnSync(PYTHON, [REPAIR_SCRIPT], {
    input: JSON.stringify({
      raw_output: raw,
      n8n_url: N8N_BASE_URL,
      api_key: N8N_API_KEY,
    }),
    encoding: 'utf-8',
    env: { ...process.env, PYTHONUTF8: '1' },
  });

  if (repairRes.error) {
    throw repairRes.error;
  }

  const output = (repairRes.stdout || '').trim();
  let repairOut;
  try {
    repairOut = JSON.parse(output);
  } catch (_) {
    throw new Error(
      (repairRes.stderr || output || `workflow_repair exited ${repairRes.status}`).trim()
    );
  }

  if (!repairOut.ok) {
    throw new Error(repairOut.error || 'Workflow validation failed');
  }
  if (repairRes.status !== 0) {
    throw new Error(`workflow_repair exited ${repairRes.status}`);
  }

  return repairOut.workflow;
}

function buildRegenerationInstruction(validationError) {
  return `Your previous workflow JSON was rejected by deterministic validation.
Generate a fresh, smaller COMPLETE workflow from the original user request. Do not reuse, quote, or patch the previous answer.

Validation errors:
${validationError}

Before responding, verify every array item in "nodes" is a JSON object with id, name, type, typeVersion, position, and parameters. Put all node configuration inside "parameters". Use only nodes required by the user. Every type must be a real n8n node type, and every connection must reference an existing node. For conditional branches, use "main": [[...], [...]], never trueBranch or falseBranch. Do not emit comments, trailing commas, or escaped text outside JSON strings. Return raw JSON only.`;
}

app.post('/generate', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'message is required' });
  }

  // 1. Call Local LLM
  let workflowJson;
  let raw = '';
  try {
    let validationError = '';
    for (let attempt = 0; attempt < MAX_WORKFLOW_GENERATION_ATTEMPTS; attempt += 1) {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message.trim() },
      ];
      if (attempt > 0) {
        messages.push({ role: 'user', content: buildRegenerationInstruction(validationError) });
      }

      const response = await openaiLocal.chat.completions.create({
        model: process.env.OLLAMA_MODEL || 'qwen2.5-coder-32b-ft-original:latest',
        max_tokens: 4096,
        // JSON mode prevents comments, markdown, and other non-JSON tokens.
        response_format: { type: 'json_object' },
        temperature: Number.parseFloat(process.env.OLLAMA_TEMPERATURE || '0') || 0,
        messages,
      });

      raw = response.choices[0]?.message?.content ?? '';
      try {
        workflowJson = repairWorkflowOutput(raw);
        break;
      } catch (validationErr) {
        validationError = validationErr.message || String(validationErr);
        if (attempt + 1 >= MAX_WORKFLOW_GENERATION_ATTEMPTS) {
          throw validationErr;
        }
        console.warn('[chatbot] workflow validation failed; requesting one regeneration:', validationError);
      }
    }
  } catch (err) {
    console.error('Claude error:', err);
    console.error('Raw LLM output was:', raw);
    return res.status(500).json({ error: `AI generation failed: ${err.message}` });
  }

  // 2. Inject into n8n
  if (!N8N_API_KEY) {
    // Return the JSON without injecting — useful during early development
    return res.json({
      message: 'Workflow generated (not injected — N8N_API_KEY not set)',
      workflow: workflowJson,
    });
  }

  try {
    const cleanedWf = stripWorkflowPayload(workflowJson);
    const n8nRes = await fetchWithRetry(`${N8N_BASE_URL}/api/v1/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': N8N_API_KEY,
        Connection: 'close',
      },
      body: JSON.stringify(cleanedWf),
      dispatcher: DIRECT_FETCH,
    }, 2);

    if (!n8nRes.ok) {
      const errText = await n8nRes.text();
      throw new Error(`n8n API returned ${n8nRes.status}: ${errText}`);
    }

    const created = await n8nRes.json();
    return res.json({
      message: `好的，已為你建立 workflow「${created.name}」。`,
      workflowId: created.id,
      workflowName: created.name,
      workflowUrl: `${process.env.N8N_PUBLIC_URL || 'http://localhost:5678'}/workflow/${created.id}`,
      workflow: created,
    });
  } catch (err) {
    console.error('n8n inject error:', err);
    // Still return the generated JSON so the user can manually import it
    return res.status(500).json({
      error: `n8n injection failed: ${err.message}`,
      workflow: workflowJson,
    });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(port, () => {
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
