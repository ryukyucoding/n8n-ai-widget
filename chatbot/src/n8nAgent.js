'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { Agent } = require('undici');
const { sanitizeCreateWorkflowPayload } = require('./workflowCreatePayload');

const PYTHON = process.env.PYTHON_BIN || 'python3';
const BRIDGE = path.join(__dirname, '..', 'python', 'widget_agent_bridge.py');
const DIRECT_FETCH = new Agent({});

function isRetryableFetchError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  const causeCode = err.cause && err.cause.code ? String(err.cause.code) : '';
  return (
    msg.includes('fetch failed') ||
    msg.includes('socket') ||
    causeCode === 'UND_ERR_SOCKET' ||
    causeCode === 'ECONNRESET' ||
    causeCode === 'EPIPE'
  );
}

async function fetchWithRetry(url, options, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (i >= retries || !isRetryableFetchError(err)) throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
}

// The edit pipeline is deliberately kept separate from workflow creation.  It
// can use a model fine-tuned for insert/delete/modify without affecting create.
const DEFAULT_EDIT_MODEL = process.env.EDIT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';

function runPythonBridge(envelope) {
  const res = spawnSync(PYTHON, [BRIDGE], {
    input: JSON.stringify(envelope),
    encoding: 'utf-8',
    maxBuffer: 48 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  const stderrText = (res.stderr || '').trim();
  if (stderrText) {
    // Python pipelines log diagnostics to stderr; spawnSync captures it unless we print.
    console.error(stderrText);
  }
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || '').trim() || `python exited ${res.status}`);
  }
  const txt = (res.stdout || '').trim();
  if (!txt) {
    throw new Error((res.stderr || '').trim() || 'Python bridge returned no output');
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`Invalid JSON from python bridge: ${txt.slice(0, 200)}`);
  }
}

const sessions = new Map();

function getOrCreateSession(sessionId) {
  const id =
    sessionId && String(sessionId).length >= 32
      ? String(sessionId)
      : crypto.randomUUID();
  if (!sessions.has(id)) {
    sessions.set(id, {
      intentPhase: 'fresh',
      originalQuery: '',
      intentQuestions: [],
      intentQuestionIndex: 0,
      intentQaPairs: [],
      phase: 'idle',
      tasks: [],
      taskIndex: 0,
      workingWorkflow: null,
      workflowSnapshot: null,
      pendingNodePick: null,
      pendingInsertClarify: null,
    });
  }
  return { id, session: sessions.get(id) };
}

function formatN8nApiError(status, bodyText, operation) {
  const detail = (bodyText || '').trim();
  if (status === 401) {
    return (
      'n8n API 認證失敗（401）。`.env` 的 N8N_API_KEY 與目前 n8n 實例不符（常見於重設 n8n 或重新建立 Owner 帳號後）。' +
      '請到 n8n → Settings → n8n API 建立新 key，更新 .env 後執行：' +
      'docker compose --env-file .env up -d --force-recreate chatbot'
    );
  }
  if (status === 403) {
    return (
      `n8n ${operation} 403：此 API key 無權存取該 workflow。` +
      (detail ? ` (${detail})` : '')
    );
  }
  return `n8n ${operation} ${status}${detail ? `: ${detail}` : ''}`;
}

async function fetchWorkflowFromN8n(workflowId, baseUrl, apiKey) {
  if (!apiKey) {
    throw new Error('N8N_API_KEY 未設定，無法讀取 workflow。');
  }
  const r = await fetchWithRetry(`${baseUrl}/api/v1/workflows/${workflowId}`, {
    headers: {
      'X-N8N-API-KEY': apiKey,
      Connection: 'close',
    },
    dispatcher: DIRECT_FETCH,
  }, 1);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(formatN8nApiError(r.status, t, 'GET workflow'));
  }
  return r.json();
}

async function putWorkflowToN8(workflowId, fullDocument, baseUrl, apiKey) {
  if (!apiKey) {
    throw new Error('N8N_API_KEY 未設定，無法寫回 workflow。');
  }
  const r = await fetchWithRetry(`${baseUrl}/api/v1/workflows/${workflowId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': apiKey,
      Connection: 'close',
    },
    body: JSON.stringify(fullDocument),
    dispatcher: DIRECT_FETCH,
  }, 2);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(formatN8nApiError(r.status, t, 'PUT workflow'));
  }
  return r.json();
}

async function verifyN8nApiKey(baseUrl, apiKey) {
  if (!apiKey) {
    return { ok: false, reason: 'missing' };
  }
  try {
    const r = await fetchWithRetry(`${baseUrl}/api/v1/workflows?limit=1`, {
      headers: {
        'X-N8N-API-KEY': apiKey,
        Connection: 'close',
      },
      dispatcher: DIRECT_FETCH,
    }, 0);
    if (r.status === 401) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, reason: 'http', status: r.status, detail: t.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'network', detail: err.message || String(err) };
  }
}

const SYSTEM_PROMPT_CREATE = `You are an expert n8n workflow builder.
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

Position nodes left-to-right, starting at [240, 300], each subsequent node +220 on the x axis.

Rules:
1. Every workflow must start with a trigger node (manualTrigger, scheduleTrigger, or webhook).
2. Node "id" values must be unique within the workflow.
3. "connections" keys are the source node's "name" field.
4. Return ONLY the JSON — no explanation, no markdown.`;

async function generateCreateWorkflow(openai, userMessage, model = DEFAULT_EDIT_MODEL) {
  const response = await openai.chat.completions.create({
    model,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_CREATE },
      { role: 'user', content: userMessage.trim() },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  return JSON.parse(jsonText);
}

const stripWorkflowPayload = sanitizeCreateWorkflowPayload;

function buildWorkflowUpdatePayload(snapshot, modified) {
  const base = stripWorkflowPayload(modified || {});
  const out = {};

  const allowedNodeKeys = new Set([
    'id',
    'name',
    'type',
    'typeVersion',
    'position',
    'parameters',
    'credentials',
    'disabled',
    'notes',
    'notesInFlow',
    'onError',
    'continueOnFail',
    'retryOnFail',
    'maxTries',
    'waitBetweenTries',
    'alwaysOutputData',
    'executeOnce',
    'webhookId',
  ]);

  function sanitizeNode(node) {
    if (!node || typeof node !== 'object') return null;
    const clean = {};
    for (const k of Object.keys(node)) {
      if (allowedNodeKeys.has(k) && node[k] !== undefined) {
        clean[k] = node[k];
      }
    }
    return clean;
  }

  const allowedSettingsKeys = new Set([
    'executionOrder',
    'saveManualExecutions',
    'saveExecutionProgress',
    'saveDataErrorExecution',
    'saveDataSuccessExecution',
    'saveDataManualExecutions',
    'timezone',
    'callerPolicy',
    'errorWorkflow',
  ]);

  function sanitizeSettings(settings) {
    if (!settings || typeof settings !== 'object') return undefined;
    const clean = {};
    for (const k of Object.keys(settings)) {
      if (allowedSettingsKeys.has(k) && settings[k] !== undefined) {
        clean[k] = settings[k];
      }
    }
    return clean;
  }

  // Required workflow graph/content fields.
  if (base.name !== undefined) out.name = base.name;
  if (Array.isArray(base.nodes)) {
    out.nodes = base.nodes.map(sanitizeNode).filter(Boolean);
  }
  if (base.connections !== undefined) out.connections = base.connections;
  if (base.settings !== undefined) {
    const settings = sanitizeSettings(base.settings);
    if (settings && Object.keys(settings).length > 0) {
      out.settings = settings;
    }
  }

  // Optional fields often accepted by n8n update schema.
  if (base.staticData !== undefined) out.staticData = base.staticData;
  if (base.pinData !== undefined) out.pinData = base.pinData;

  return out;
}

/**
 * Main entry: processes one user message for the agentic widget.
 */
async function processAgentMessage({
  openai,
  n8nBaseUrl,
  n8nApiKey,
  sessionId: incomingSessionId,
  message,
  workflowId,
  clearSession,
  model,
  modelConfig,
}) {
  if (clearSession && incomingSessionId && sessions.has(incomingSessionId)) {
    sessions.delete(incomingSessionId);
  }

  const { id: sessionId, session } = getOrCreateSession(
    clearSession ? null : incomingSessionId
  );

  // Pin a multi-turn edit session to the first selected model.  Switching a
  // dropdown while answering a clarification must not mix two trained models.
  const selectedModelConfig = session.modelConfig || modelConfig || { model: model || DEFAULT_EDIT_MODEL };
  session.modelConfig = selectedModelConfig;
  const selectedModel = selectedModelConfig.model;

  const apiKey = process.env.OPENAI_API_KEY;

  if (session.intentPhase === 'fresh' && session.phase === 'idle' && !session.pendingNodePick && !session.pendingInsertClarify) {
    session.originalQuery = (message || '').trim();
  }

  if (session.pendingInsertClarify) {
    const ctx = session.pendingInsertClarify;
    const enriched = `${ctx.instruction}\n\n(使用者補充：${message.trim()})`;
    session.pendingInsertClarify = null;
    const ins = runPythonBridge({
      command: 'insert',
      payload: {
        workflow: ctx.workflow,
        instruction: enriched,
        model: selectedModel,
        api_key: selectedModelConfig.apiKey || apiKey,
        base_url: selectedModelConfig.baseUrl,
        basic_auth: selectedModelConfig.basicAuth,
      },
    });
    if (!ins.ok) {
      return { ok: false, sessionId, error: ins.error || 'insert bridge failed' };
    }
    const res = ins.result;
    if (!res.ok && res.needs_clarification) {
      session.pendingInsertClarify = { workflow: ctx.workflow, instruction: enriched };
      return {
        ok: true,
        sessionId,
        action: 'clarify',
        clarifyKind: 'insert',
        message: res.message || '需要更多資訊才能完成插入。',
      };
    }
    if (!res.ok || !res.modified_workflow) {
      return {
        ok: false,
        sessionId,
        error: res.message || 'Insert failed',
        detail: res,
      };
    }
    session.workingWorkflow = res.modified_workflow;
    session.pendingInsertClarify = null;
    session.taskIndex += 1;
    session.phase = 'execute';
    return advanceTasks({
      openai,
      n8nBaseUrl,
      n8nApiKey,
      sessionId,
      session,
      workflowId,
      apiKey,
      model: selectedModel,
      modelConfig: selectedModelConfig,
    });
  }

  if (session.pendingNodePick) {
    const p = session.pendingNodePick;
    const names = message
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) {
      return {
        ok: true,
        sessionId,
        action: 'clarify',
        clarifyKind: 'node_pick',
        message: '請輸入要操作的節點「顯示名稱」（與畫布上相同）。可多個，用逗號分開。',
        candidates: p.candidates || [],
      };
    }
    const payloadBase = {
      workflow: p.workflow,
      instruction: p.instruction,
      model: selectedModel,
      api_key: selectedModelConfig.apiKey || apiKey,
      base_url: selectedModelConfig.baseUrl,
      basic_auth: selectedModelConfig.basicAuth,
      confirmed_node_names: names,
    };
    let bridgeOut;
    if (p.operation === 'modify') {
      bridgeOut = runPythonBridge({ command: 'modify', payload: payloadBase });
    } else if (p.operation === 'delete') {
      bridgeOut = runPythonBridge({ command: 'delete', payload: payloadBase });
    } else {
      return { ok: false, sessionId, error: 'invalid pending operation' };
    }
    session.pendingNodePick = null;
    if (!bridgeOut.ok) {
      return { ok: false, sessionId, error: bridgeOut.error || 'bridge error' };
    }
    const result = bridgeOut.result;
    if (!result.ok) {
      session.pendingNodePick = {
        workflow: p.workflow,
        instruction: p.instruction,
        operation: p.operation,
        candidates: extractCandidates(result),
        resolution: result.resolution,
      };
      return {
        ok: true,
        sessionId,
        action: 'clarify',
        clarifyKind: 'node_pick',
        message:
          result.message ||
          '仍無法鎖定節點，請從下列候選中回覆正確的節點名稱。',
        candidates: session.pendingNodePick.candidates,
      };
    }
    session.workingWorkflow = result.modified_workflow;
    session.taskIndex += 1;
    return advanceTasks({
      openai,
      n8nBaseUrl,
      n8nApiKey,
      sessionId,
      session,
      workflowId,
      apiKey,
      model: selectedModel,
      modelConfig: selectedModelConfig,
    });
  }

  if (session.intentPhase === 'asking') {
    const q = session.intentQuestions[session.intentQuestionIndex];
    session.intentQaPairs.push({
      question: q,
      answer: message.trim(),
    });
    session.intentQuestionIndex += 1;
    if (session.intentQuestionIndex < session.intentQuestions.length) {
      const nq = session.intentQuestions[session.intentQuestionIndex];
      return {
        ok: true,
        sessionId,
        action: 'clarify',
        clarifyKind: 'intent',
        message: nq,
      };
    }
    session.intentPhase = 'done';
    const dec = runPythonBridge({
      command: 'decompose',
      payload: {
        query: session.originalQuery,
        qa_pairs: session.intentQaPairs,
        api_key: apiKey,
      },
    });
    if (!dec.ok) {
      return { ok: false, sessionId, error: dec.error || 'decompose failed' };
    }
    const dr = dec.result;
    if (dr.needs_clarification) {
      session.intentQuestions = dr.questions || [];
      session.intentQuestionIndex = 0;
      session.intentQaPairs = [];
      session.intentPhase = 'asking';
      return {
        ok: true,
        sessionId,
        action: 'clarify',
        clarifyKind: 'intent',
        message: session.intentQuestions[0] || '需要補充資訊。',
      };
    }
    session.tasks = dr.tasks || [];
    session.taskIndex = 0;
    session.intentPhase = 'done';
    session.phase = 'execute';
    return startExecutePhase({
      n8nBaseUrl,
      n8nApiKey,
      sessionId,
      session,
      workflowId,
      apiKey,
      model: selectedModel,
      modelConfig: selectedModelConfig,
    });
  }

  const dec = runPythonBridge({
    command: 'decompose',
    payload: {
      query: session.originalQuery || message.trim(),
      qa_pairs: null,
      api_key: apiKey,
    },
  });

  if (!dec.ok) {
    return { ok: false, sessionId, error: dec.error || 'decompose failed' };
  }
  const dres = dec.result;
  if (dres.needs_clarification) {
    session.intentPhase = 'asking';
    session.intentQuestions = dres.questions || [];
    session.intentQuestionIndex = 0;
    session.intentQaPairs = [];
    session.phase = 'idle';
    return {
      ok: true,
      sessionId,
      action: 'clarify',
      clarifyKind: 'intent',
      message: session.intentQuestions[0] || '需要補充資訊。',
    };
  }

  session.tasks = dres.tasks || [];
  session.taskIndex = 0;
  session.intentPhase = 'done';
  session.phase = 'execute';

  return startExecutePhase({
    n8nBaseUrl,
    n8nApiKey,
    sessionId,
    session,
    workflowId,
    apiKey,
    model: selectedModel,
    modelConfig: selectedModelConfig,
  });
}

function extractCandidates(result) {
  const res = result.resolution || {};
  const c = res.candidates;
  if (!Array.isArray(c)) return [];
  return c
    .map((x) => (x && x.name) || null)
    .filter(Boolean);
}

function ensureSentence(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (/[。．.!?！？]$/.test(s)) return s;
  return `${s}。`;
}

function nodeDisplayName(node) {
  if (!node) return '節點';
  return node.name || node.type || '節點';
}

function summarizeWorkflowDiff(before, after) {
  const beforeNodes = Array.isArray(before?.nodes) ? before.nodes : [];
  const afterNodes = Array.isArray(after?.nodes) ? after.nodes : [];
  const beforeByName = new Map(beforeNodes.map((n) => [n.name, n]));
  const afterByName = new Map(afterNodes.map((n) => [n.name, n]));

  const added = [];
  const removed = [];
  const modified = [];

  for (const node of afterNodes) {
    if (!node?.name || !beforeByName.has(node.name)) added.push(node);
  }
  for (const node of beforeNodes) {
    if (node?.name && !afterByName.has(node.name)) removed.push(node.name);
  }
  for (const node of afterNodes) {
    if (!node?.name) continue;
    const prev = beforeByName.get(node.name);
    if (!prev) continue;
    const prevJson = JSON.stringify({
      parameters: prev.parameters,
      type: prev.type,
      typeVersion: prev.typeVersion,
      disabled: prev.disabled,
    });
    const nextJson = JSON.stringify({
      parameters: node.parameters,
      type: node.type,
      typeVersion: node.typeVersion,
      disabled: node.disabled,
    });
    if (prevJson !== nextJson) modified.push(node);
  }

  return { added, removed, modified };
}

function buildDiffFallbackMessage(diff) {
  const parts = [];
  if (diff.added.length) {
    parts.push(`新增了 ${diff.added.map(nodeDisplayName).join('、')} 節點`);
  }
  if (diff.removed.length) {
    parts.push(`移除了 ${diff.removed.join('、')} 節點`);
  }
  if (diff.modified.length) {
    parts.push(`更新了 ${diff.modified.map(nodeDisplayName).join('、')} 的設定`);
  }
  if (!parts.length) return '已依照你的指示更新 workflow';
  return parts.join('，');
}

function buildCompletionMessage(session, snapshot, working) {
  const tasks = (session.tasks || []).filter((t) => {
    const op = (t.operation || '').toLowerCase();
    return op === 'modify' || op === 'delete' || op === 'insert';
  });
  const diff = summarizeWorkflowDiff(snapshot, working);

  const descriptions = tasks
    .map((t) => String(t.description || '').trim())
    .filter(Boolean);

  if (descriptions.length === 1) {
    return `好的，沒問題！${ensureSentence(descriptions[0])}你可以在畫布上直接看到更新。`;
  }

  if (descriptions.length > 1) {
    const body = descriptions
      .map((d, i) => `${i + 1}. ${ensureSentence(d)}`)
      .join('\n');
    return `好的，我依序完成了這些調整：\n\n${body}\n\n你可以在畫布上直接看到更新。`;
  }

  const summary = buildDiffFallbackMessage(diff);
  return `好的，沒問題！${ensureSentence(summary)}你可以在畫布上直接看到更新。`;
}

async function startExecutePhase({ n8nBaseUrl, n8nApiKey, sessionId, session, workflowId, apiKey, model, modelConfig }) {
  const needsCanvas = session.tasks.some((t) =>
    ['modify', 'delete', 'insert'].includes((t.operation || '').toLowerCase())
  );
  if (needsCanvas && !workflowId) {
    return {
      ok: false,
      sessionId,
      error:
        '此需求需要編輯「目前開啟的 workflow」。請在 n8n 開啟目標 workflow 分頁後再開啟聊天面板（會自動帶入 workflow id）。',
      tasks: session.tasks,
    };
  }
  if (workflowId && n8nApiKey && needsCanvas) {
    const doc = await fetchWorkflowFromN8n(workflowId, n8nBaseUrl, n8nApiKey);
    session.workflowSnapshot = doc;
    session.workingWorkflow = {
      name: doc.name,
      nodes: doc.nodes,
      connections: doc.connections,
      settings: doc.settings,
      staticData: doc.staticData,
    };
  }
  return advanceTasks({
    openai: null,
    n8nBaseUrl,
    n8nApiKey,
    sessionId,
    session,
    workflowId,
    apiKey,
    model,
    modelConfig,
  });
}

async function advanceTasks({
  openai,
  n8nBaseUrl,
  n8nApiKey,
  sessionId,
  session,
  workflowId,
  apiKey,
  model,
  modelConfig,
}) {
  while (session.taskIndex < session.tasks.length) {
    const task = session.tasks[session.taskIndex];
    const op = (task.operation || '').toLowerCase();
    const desc = task.description || '';

    if (op === 'create') {
      session.taskIndex += 1;
      continue;
    }

    if (!['modify', 'delete', 'insert'].includes(op)) {
      session.taskIndex += 1;
      continue;
    }

    if (!session.workingWorkflow) {
      return {
        ok: false,
        sessionId,
        error: 'Internal: 沒有可編輯的 workflow 資料。',
      };
    }

    const wf = session.workingWorkflow;

    if (op === 'modify') {
      const bridgeOut = runPythonBridge({
        command: 'modify',
        payload: {
          workflow: wf,
          instruction: desc,
          model,
          api_key: modelConfig?.apiKey || apiKey,
          base_url: modelConfig?.baseUrl,
          basic_auth: modelConfig?.basicAuth,
        },
      });
      if (!bridgeOut.ok) {
        return { ok: false, sessionId, error: bridgeOut.error };
      }
      const result = bridgeOut.result;
      if (!result.ok) {
        session.pendingNodePick = {
          workflow: wf,
          instruction: desc,
          operation: 'modify',
          candidates: extractCandidates(result),
        };
        return {
          ok: true,
          sessionId,
          action: 'clarify',
          clarifyKind: 'node_pick',
          message:
            result.message ||
            '請指定要修改的節點名稱，或從候選中選一個。',
          candidates: session.pendingNodePick.candidates,
        };
      }
      session.workingWorkflow = result.modified_workflow;
      session.taskIndex += 1;
      continue;
    }

    if (op === 'delete') {
      const bridgeOut = runPythonBridge({
        command: 'delete',
        payload: {
          workflow: wf,
          instruction: desc,
          model,
          api_key: modelConfig?.apiKey || apiKey,
          base_url: modelConfig?.baseUrl,
          basic_auth: modelConfig?.basicAuth,
        },
      });
      if (!bridgeOut.ok) {
        return { ok: false, sessionId, error: bridgeOut.error };
      }
      const result = bridgeOut.result;
      if (!result.ok && result.step === 'type_disambiguation') {
        session.pendingNodePick = {
          workflow: wf,
          instruction: desc,
          operation: 'delete',
          candidates: result.candidates || [],
        };
        return {
          ok: true,
          sessionId,
          action: 'clarify',
          clarifyKind: 'node_pick',
          message:
            result.message || '請選擇要刪除的節點（顯示名稱）。',
          candidates: result.candidates || [],
        };
      }
      if (!result.ok) {
        session.pendingNodePick = {
          workflow: wf,
          instruction: desc,
          operation: 'delete',
          candidates: extractCandidates(result),
        };
        return {
          ok: true,
          sessionId,
          action: 'clarify',
          clarifyKind: 'node_pick',
          message:
            result.message ||
            '請指定要刪除的節點。',
          candidates: session.pendingNodePick.candidates,
        };
      }
      session.workingWorkflow = result.modified_workflow;
      session.taskIndex += 1;
      continue;
    }

    if (op === 'insert') {
      const bridgeOut = runPythonBridge({
        command: 'insert',
        payload: {
          workflow: wf,
          instruction: desc,
          model,
          api_key: modelConfig?.apiKey || apiKey,
          base_url: modelConfig?.baseUrl,
          basic_auth: modelConfig?.basicAuth,
        },
      });
      if (!bridgeOut.ok) {
        return { ok: false, sessionId, error: bridgeOut.error };
      }
      const result = bridgeOut.result;
      if (!result.ok && result.needs_clarification) {
        session.pendingInsertClarify = { workflow: wf, instruction: desc };
        return {
          ok: true,
          sessionId,
          action: 'clarify',
          clarifyKind: 'insert',
          message: result.message || '需要更多資訊才能插入節點。',
        };
      }
      if (!result.ok || !result.modified_workflow) {
        return {
          ok: false,
          sessionId,
          error: result.message || 'Insert 失敗',
          detail: result,
        };
      }
      session.workingWorkflow = result.modified_workflow;
      session.taskIndex += 1;
      continue;
    }
  }

  if (workflowId && n8nApiKey && session.workflowSnapshot && session.workingWorkflow) {
    const payload = buildWorkflowUpdatePayload(
      session.workflowSnapshot,
      session.workingWorkflow
    );
    const saved = await putWorkflowToN8(workflowId, payload, n8nBaseUrl, n8nApiKey);
    const completionMessage = buildCompletionMessage(
      session,
      session.workflowSnapshot,
      session.workingWorkflow
    );
    sessions.delete(sessionId);
    return {
      ok: true,
      sessionId,
      action: 'done',
      message: completionMessage,
      workflow: saved,
      workflowUrl: `${process.env.N8N_PUBLIC_URL || 'http://localhost:5678'}/workflow/${saved.id}`,
    };
  }

  const finalWf = session.workingWorkflow;
  const completionMessage = buildCompletionMessage(
    session,
    session.workflowSnapshot,
    finalWf
  );
  sessions.delete(sessionId);
  return {
    ok: true,
    sessionId,
    action: 'done',
    message: completionMessage || '好的，已處理你的請求。',
    workflow: finalWf,
  };
}

module.exports = {
  processAgentMessage,
  generateCreateWorkflow,
  stripWorkflowPayload,
  getOrCreateSession,
  verifyN8nApiKey,
};
