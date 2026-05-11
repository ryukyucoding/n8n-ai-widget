'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { Agent } = require('undici');

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

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

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

async function fetchWorkflowFromN8n(workflowId, baseUrl, apiKey) {
  const r = await fetchWithRetry(`${baseUrl}/api/v1/workflows/${workflowId}`, {
    headers: {
      'X-N8N-API-KEY': apiKey,
      Connection: 'close',
    },
    dispatcher: DIRECT_FETCH,
  }, 1);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`n8n GET workflow ${r.status}: ${t}`);
  }
  return r.json();
}

async function putWorkflowToN8(workflowId, fullDocument, baseUrl, apiKey) {
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
    throw new Error(`n8n PUT workflow ${r.status}: ${t}`);
  }
  return r.json();
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

async function generateCreateWorkflow(openai, userMessage) {
  const response = await openai.chat.completions.create({
    model: MODEL,
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

function stripWorkflowPayload(doc) {
  const keys = [
    'name',
    'nodes',
    'connections',
    'settings',
    'staticData',
    'pinData',
    'meta',
  ];
  const o = {};
  for (const k of keys) {
    if (doc[k] !== undefined) o[k] = doc[k];
  }
  return o;
}

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
}) {
  if (clearSession && incomingSessionId && sessions.has(incomingSessionId)) {
    sessions.delete(incomingSessionId);
  }

  const { id: sessionId, session } = getOrCreateSession(
    clearSession ? null : incomingSessionId
  );

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
        model: MODEL,
        api_key: apiKey,
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
      model: MODEL,
      api_key: apiKey,
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

async function startExecutePhase({ n8nBaseUrl, n8nApiKey, sessionId, session, workflowId, apiKey }) {
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
          model: MODEL,
          api_key: apiKey,
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
          model: MODEL,
          api_key: apiKey,
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
          model: MODEL,
          api_key: apiKey,
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
    sessions.delete(sessionId);
    return {
      ok: true,
      sessionId,
      action: 'done',
      message: '所有步驟已完成，workflow 已寫回 n8n。',
      workflow: saved,
      workflowUrl: `${process.env.N8N_PUBLIC_URL || 'http://localhost:5678'}/workflow/${saved.id}`,
    };
  }

  const finalWf = session.workingWorkflow;
  sessions.delete(sessionId);
  return {
    ok: true,
    sessionId,
    action: 'done',
    message: '處理完成（未寫入 n8n，無 workflow id 或 API key）。',
    workflow: finalWf,
  };
}

module.exports = {
  processAgentMessage,
  generateCreateWorkflow,
  stripWorkflowPayload,
  getOrCreateSession,
};
