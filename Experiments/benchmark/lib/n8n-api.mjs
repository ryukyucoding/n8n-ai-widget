/**
 * Minimal n8n REST helpers for benchmark runners.
 */

import { sleep } from './args.mjs';

export function n8nHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-N8N-API-KEY': apiKey,
  };
}

function cloneNodesWithoutSecrets(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    const { credentials, webhookId, ...rest } = node;
    return rest;
  });
}

export function nodeNames(workflow) {
  return new Set(
    (workflow?.nodes || [])
      .map((n) => (n && typeof n === 'object' ? n.name : null))
      .filter((name) => typeof name === 'string' && name.length > 0)
  );
}

/** Build id/name → node.name lookup from workflow nodes. */
export function buildNodeRefMaps(nodes) {
  const idToName = new Map();
  const names = new Set();
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') continue;
    const name = node.name;
    if (typeof name !== 'string' || !name.length) continue;
    names.add(name);
    idToName.set(name, name);
    if (node.id != null && String(node.id).length) {
      idToName.set(String(node.id), name);
    }
  }
  return { idToName, names };
}

function resolveNodeRef(ref, idToName, names) {
  if (typeof ref !== 'string' || !ref.length) return ref;
  if (names.has(ref)) return ref;
  return idToName.get(ref) || ref;
}

function mergeConnectionOutputs(existing, incoming) {
  const out = { ...existing };
  for (const [outputType, branches] of Object.entries(incoming || {})) {
    if (!Array.isArray(branches)) continue;
    if (!Array.isArray(out[outputType])) {
      out[outputType] = branches.map((b) => (Array.isArray(b) ? [...b] : b));
      continue;
    }
    for (let i = 0; i < branches.length; i += 1) {
      if (!Array.isArray(out[outputType][i])) out[outputType][i] = [];
      if (Array.isArray(branches[i])) {
        out[outputType][i] = [...out[outputType][i], ...branches[i]];
      }
    }
  }
  return out;
}

/**
 * Rewrite n8n connections so source keys and target.node use node.name.
 * Models often emit node.id (e.g. "c1", "error-trigger") instead of display names.
 */
export function remapWorkflowConnectionsToNodeNames(workflow) {
  if (!workflow || typeof workflow !== 'object') return workflow;
  const nodes = workflow.nodes || [];
  const { idToName, names } = buildNodeRefMaps(nodes);
  const conns = workflow.connections;
  if (!conns || typeof conns !== 'object') {
    workflow.connections = {};
    return workflow;
  }

  const remapped = {};
  for (const [src, outputs] of Object.entries(conns)) {
    const srcName = resolveNodeRef(src, idToName, names);
    if (!outputs || typeof outputs !== 'object') continue;

    const cleanedOutputs = {};
    for (const [outputType, branches] of Object.entries(outputs)) {
      if (!Array.isArray(branches)) continue;
      cleanedOutputs[outputType] = branches.map((branch) => {
        if (!Array.isArray(branch)) return branch;
        return branch.map((target) => {
          if (!target || typeof target !== 'object') return target;
          if (typeof target.node !== 'string') return target;
          return {
            ...target,
            node: resolveNodeRef(target.node, idToName, names),
          };
        });
      });
    }

    remapped[srcName] = remapped[srcName]
      ? mergeConnectionOutputs(remapped[srcName], cleanedOutputs)
      : cleanedOutputs;
  }

  workflow.connections = remapped;
  return workflow;
}

/** Remove connection entries pointing at nodes that are not in workflow.nodes. */
export function sanitizeWorkflowConnections(workflow) {
  const names = nodeNames(workflow);
  const conns = workflow.connections;
  if (!conns || typeof conns !== 'object') {
    workflow.connections = {};
    return workflow;
  }

  const cleaned = {};
  for (const [src, outputs] of Object.entries(conns)) {
    if (!names.has(src)) continue;
    if (!outputs || typeof outputs !== 'object') continue;

    const cleanedOutputs = {};
    for (const [outputType, branches] of Object.entries(outputs)) {
      if (!Array.isArray(branches)) continue;
      const cleanedBranches = branches.map((branch) => {
        if (!Array.isArray(branch)) return branch;
        return branch.filter(
          (t) => t && typeof t === 'object' && typeof t.node === 'string' && names.has(t.node)
        );
      });
      if (cleanedBranches.some((b) => Array.isArray(b) && b.length > 0)) {
        cleanedOutputs[outputType] = cleanedBranches;
      }
    }
    if (Object.keys(cleanedOutputs).length > 0) {
      cleaned[src] = cleanedOutputs;
    }
  }

  workflow.connections = cleaned;
  return workflow;
}

export function workflowSignature(workflow) {
  const names = [...nodeNames(workflow)].sort();
  return JSON.stringify({
    nodes: names,
    connections: workflow?.connections || {},
  });
}

function cloneWorkflow(workflow) {
  return JSON.parse(JSON.stringify(workflow));
}

export function stripWorkflowForImport(workflow, name) {
  const out = sanitizeWorkflowConnections(
    remapWorkflowConnectionsToNodeNames(
      cloneWorkflow({
        name: name || workflow.name || 'benchmark-case',
        nodes: cloneNodesWithoutSecrets(workflow.nodes),
        connections: workflow.connections || {},
        settings: workflow.settings || { executionOrder: 'v1' },
        pinData: workflow.pinData,
        staticData: workflow.staticData,
      })
    )
  );
  out.name = name || workflow.name || 'benchmark-case';
  if (!out.pinData || !Object.keys(out.pinData).length) delete out.pinData;
  if (!out.staticData) delete out.staticData;
  return out;
}

export async function createWorkflow(baseUrl, apiKey, workflowDoc) {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/workflows`, {
    method: 'POST',
    headers: n8nHeaders(apiKey),
    body: JSON.stringify(workflowDoc),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`n8n POST workflow ${r.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

export async function getWorkflow(baseUrl, apiKey, workflowId) {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/workflows/${workflowId}`, {
    headers: n8nHeaders(apiKey),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`n8n GET workflow ${r.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

export async function updateWorkflow(baseUrl, apiKey, workflowId, workflowDoc) {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/workflows/${workflowId}`, {
    method: 'PUT',
    headers: n8nHeaders(apiKey),
    body: JSON.stringify(workflowDoc),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`n8n PUT workflow ${r.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

export async function deleteWorkflow(baseUrl, apiKey, workflowId) {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/workflows/${workflowId}`, {
    method: 'DELETE',
    headers: n8nHeaders(apiKey),
  });
  if (!r.ok && r.status !== 404) {
    const text = await r.text();
    throw new Error(`n8n DELETE workflow ${r.status}: ${text.slice(0, 300)}`);
  }
}

async function tryTriggerSave(page) {
  if (!page) return;

  const saveSelectors = [
    '[data-test-id="workflow-save-button"]',
    '[data-test-id="save-workflow-button"]',
    'button:has-text("Save")',
  ];
  for (const sel of saveSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await sleep(1200);
      return;
    }
  }

  const isMac = process.platform === 'darwin';
  await page.keyboard.press(isMac ? 'Meta+KeyS' : 'Control+KeyS').catch(() => {});
  await sleep(1200);
}

/**
 * Poll GET /workflows until the document differs from baseline (Builder autosave),
 * optionally nudging save from the open editor page.
 */
export async function waitForPersistedWorkflow(
  baseUrl,
  apiKey,
  workflowId,
  baseline,
  { page = null, timeoutMs = 90000, pollMs = 2500 } = {}
) {
  const baseSig = workflowSignature(baseline);
  const started = Date.now();
  let last = null;
  let attempts = 0;

  await tryTriggerSave(page);

  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    last = await getWorkflow(baseUrl, apiKey, workflowId);
    const sig = workflowSignature(last);
    if (sig !== baseSig) {
      return {
        workflow: last,
        persisted: true,
        attempts,
        elapsedMs: Date.now() - started,
        baseSignature: baseSig,
        finalSignature: sig,
      };
    }

    if (attempts % 3 === 0) {
      await tryTriggerSave(page);
    }
    await sleep(pollMs);
  }

  return {
    workflow: last || baseline,
    persisted: false,
    attempts,
    elapsedMs: Date.now() - started,
    baseSignature: baseSig,
    finalSignature: last ? workflowSignature(last) : baseSig,
  };
}
