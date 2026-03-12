'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Serve the browser-side widget script (injected into n8n via EXTERNAL_FRONTEND_HOOKS_URLS)
app.get('/widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'widget.js'));
});

// Serve the chat UI inside the iframe
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
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
- n8n-nodes-base.scheduleTrigger (typeVersion 1.2) — parameters: { "rule": { "interval": [{ "field": "hours", "hoursInterval": 1 }] } }
- n8n-nodes-base.webhook (typeVersion 2) — parameters: { "httpMethod": "POST", "path": "my-path", "responseMode": "onReceived" }
- n8n-nodes-base.httpRequest (typeVersion 4.2) — parameters: { "method": "GET", "url": "https://..." }
- n8n-nodes-base.emailSend (typeVersion 2.1) — parameters: { "fromEmail": "...", "toEmail": "...", "subject": "...", "emailType": "text", "message": "..." }
- n8n-nodes-base.set (typeVersion 3.4) — parameters: { "mode": "manual", "fields": { "values": [{ "name": "key", "type": "stringValue", "string": "value" }] } }
- n8n-nodes-base.if (typeVersion 2.2) — parameters: { "conditions": { "options": { "caseSensitive": true }, "conditions": [{ "leftValue": "={{ $json.field }}", "rightValue": "expected", "operator": { "type": "string", "operation": "equals" } }], "combinator": "and" } }
- n8n-nodes-base.code (typeVersion 2) — parameters: { "jsCode": "return items;" }
- n8n-nodes-base.noOp (typeVersion 1) — no parameters, use as placeholder
- @n8n/n8n-nodes-langchain.lmChatOpenAi (typeVersion 1) — LLM node for AI chains
- @n8n/n8n-nodes-langchain.chainLlm (typeVersion 1.5) — basic LLM chain

Position nodes left-to-right, starting at [240, 300], each subsequent node +220 on the x axis.

Rules:
1. Every workflow must start with a trigger node (manualTrigger, scheduleTrigger, or webhook).
2. Node "id" values must be unique within the workflow.
3. "connections" keys are the source node's "name" field.
4. Return ONLY the JSON — no explanation, no markdown.`;

app.post('/generate', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'message is required' });
  }

  // 1. Call Claude
  let workflowJson;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message.trim() },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';

    // Strip markdown code fences if Claude adds them despite instructions
    const jsonText = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    workflowJson = JSON.parse(jsonText);
  } catch (err) {
    console.error('Claude error:', err);
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
    const n8nRes = await fetch(`${N8N_BASE_URL}/api/v1/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': N8N_API_KEY,
      },
      body: JSON.stringify(workflowJson),
    });

    if (!n8nRes.ok) {
      const errText = await n8nRes.text();
      throw new Error(`n8n API returned ${n8nRes.status}: ${errText}`);
    }

    const created = await n8nRes.json();
    return res.json({
      message: `Workflow "${created.name}" created successfully!`,
      workflowId: created.id,
      workflowName: created.name,
      workflowUrl: `http://localhost:5678/workflow/${created.id}`,
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
});
