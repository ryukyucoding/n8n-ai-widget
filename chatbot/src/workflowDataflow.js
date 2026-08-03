'use strict';

const CODE_REFERENCE_PATTERN = /\$\(\s*(['\"])([^'\"\n]+)\1\s*\)\s*\.\s*(first|all|item|itemMatching)\s*\(/g;

const fs = require('node:fs');
const path = require('node:path');
const RUNTIME_SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'runtime_node_schemas.json');
let cachedRuntimeSchemas;

function runtimeSchemas() {
  if (cachedRuntimeSchemas !== undefined) return cachedRuntimeSchemas;
  try {
    cachedRuntimeSchemas = JSON.parse(fs.readFileSync(RUNTIME_SCHEMA_PATH, 'utf8')).nodeTypes || {};
  } catch (_) {
    cachedRuntimeSchemas = {};
  }
  return cachedRuntimeSchemas;
}

function runtimeDescription(node, schemas) {
  const entry = (schemas || runtimeSchemas())[node?.type];
  const versions = entry && typeof entry === 'object' ? entry.versions : null;
  if (!versions || typeof versions !== 'object') return null;
  const requestedVersion = node?.typeVersion;
  if (requestedVersion !== undefined && requestedVersion !== null) {
    for (const [version, description] of Object.entries(versions)) {
      if (Number(version) === Number(requestedVersion) && description && typeof description === 'object') return description;
    }
    return null;
  }
  const available = Object.keys(versions).filter((version) => Number.isFinite(Number(version))).sort((left, right) => Number(right) - Number(left));
  return available.length ? versions[available[0]] : null;
}

function inputPortsFromRuntime(node, schemas) {
  const inputs = runtimeDescription(node, schemas)?.inputs;
  if (!Array.isArray(inputs)) return null;
  const ports = [];
  for (const input of inputs) {
    if (typeof input === 'string') ports.push(input);
    else if (input && typeof input.type === 'string') ports.push(input.type);
    else return null;
  }
  return ports;
}

function executionContractFor(node, incoming, schemas) {
  const inputPorts = inputPortsFromRuntime(node, schemas);
  if (inputPorts === null) return { kind: 'unknown', reason: 'runtime schema does not expose a static input-port contract' };
  if (inputPorts.length <= 1) return { kind: 'any-input-trigger', inputPorts };
  const declaredContract = runtimeDescription(node, schemas)?.executionContract;
  const requiredInputIndices = declaredContract && declaredContract.kind === 'all-required-inputs-barrier'
    && Array.isArray(declaredContract.requiredInputIndices)
    ? declaredContract.requiredInputIndices
    : null;
  if (!requiredInputIndices || requiredInputIndices.length !== inputPorts.length
    || requiredInputIndices.some((index, expected) => index !== expected)) {
    return {
      kind: 'unknown',
      reason: 'runtime schema exposes multiple inputs but does not verify all-required-inputs execution semantics',
      inputPorts,
    };
  }
  const connectedInputs = new Set((incoming || []).map((edge) => edge.inputIndex));
  if (requiredInputIndices.every((index) => connectedInputs.has(index))) {
    return {
      kind: 'all-required-inputs-barrier',
      inputPorts,
      requiredInputIndices,
      verifiedBy: 'runtime execution contract',
    };
  }
  return {
    kind: 'unknown',
    reason: 'runtime barrier contract requires every input index, but the workflow does not populate every one',
    inputPorts,
  };
}

function union(sets) {
  const result = new Set();
  for (const values of sets) {
    for (const value of values) result.add(value);
  }
  return result;
}

function intersection(sets) {
  if (!sets.length) return new Set();
  const result = new Set(sets[0]);
  for (const values of sets.slice(1)) {
    for (const value of result) {
      if (!values.has(value)) result.delete(value);
    }
  }
  return result;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function prerequisitesFor(edge, mustBefore) {
  return new Set([edge.from, ...(mustBefore.get(edge.from) || [])]);
}

/**
 * Compute the nodes that are proven to have executed before each node. A
 * graph edge only proves ordering for the branch that triggers it. An
 * any-input node can be started by any one incoming edge, so its guaranteed
 * prerequisites are the intersection across those alternatives. A barrier is
 * accepted only when the runtime schema statically exposes every required
 * input and the candidate connects every one of them.
 */
function computeMustExecuteBefore(nodes, incoming, schemas) {
  const contracts = new Map();
  const mustBefore = new Map();
  for (const node of nodes) {
    contracts.set(node.name, executionContractFor(node, incoming.get(node.name) || [], schemas));
    mustBefore.set(node.name, new Set());
  }

  for (let pass = 0; pass < Math.max(1, nodes.length); pass += 1) {
    let changed = false;
    for (const node of nodes) {
      const nodeIncoming = incoming.get(node.name) || [];
      const contract = contracts.get(node.name);
      let next = new Set();
      if (contract.kind === 'any-input-trigger') {
        next = intersection(nodeIncoming.map((edge) => prerequisitesFor(edge, mustBefore)));
      } else if (contract.kind === 'all-required-inputs-barrier') {
        next = union(nodeIncoming.map((edge) => prerequisitesFor(edge, mustBefore)));
      }
      if (!sameSet(next, mustBefore.get(node.name))) {
        mustBefore.set(node.name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { contracts, mustBefore };
}
function connectionsFrom(workflow) {
  const outgoing = new Map();
  const incoming = new Map();
  for (const node of workflow.nodes || []) {
    outgoing.set(node.name, []);
    incoming.set(node.name, []);
  }
  for (const [source, outputs] of Object.entries(workflow.connections || {})) {
    for (const [connectionType, branches] of Object.entries(outputs || {})) {
      if (!Array.isArray(branches)) continue;
      branches.forEach((branch, outputIndex) => {
        if (!Array.isArray(branch)) return;
        for (const connection of branch) {
          if (!connection || typeof connection.node !== 'string') continue;
          const edge = {
            from: source,
            to: connection.node,
            connectionType,
            outputIndex,
            inputIndex: Number.isInteger(connection.index) ? connection.index : 0,
          };
          if (!outgoing.has(source)) outgoing.set(source, []);
          if (!incoming.has(connection.node)) incoming.set(connection.node, []);
          outgoing.get(source).push(edge);
          incoming.get(connection.node).push(edge);
        }
      });
    }
  }
  return { outgoing, incoming };
}

function isReachable(outgoing, source, target) {
  if (source === target) return false;
  const seen = new Set([source]);
  const pending = [source];
  while (pending.length) {
    const current = pending.shift();
    for (const edge of outgoing.get(current) || []) {
      if (edge.to === target) return true;
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        pending.push(edge.to);
      }
    }
  }
  return false;
}

function codeReferences(node) {
  const jsCode = node?.parameters?.jsCode;
  if (typeof jsCode !== 'string') return [];
  const references = [];
  CODE_REFERENCE_PATTERN.lastIndex = 0;
  for (let match = CODE_REFERENCE_PATTERN.exec(jsCode); match; match = CODE_REFERENCE_PATTERN.exec(jsCode)) {
    references.push({ referencedNode: match[2].trim(), accessor: match[3] });
  }
  return references;
}

function buildWorkflowDataflowSummary(workflow, options = {}) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const nodeByName = new Map(nodes.filter((node) => node && typeof node.name === 'string')
    .map((node) => [node.name, node]));
  const { outgoing, incoming } = connectionsFrom(workflow || {});
  const execution = computeMustExecuteBefore(nodes, incoming, options.runtimeSchemas);
  const codeNodeReferences = [];

  for (const node of nodes) {
    if (node?.type !== 'n8n-nodes-base.code') continue;
    const mustExecuteBefore = execution.mustBefore.get(node.name) || new Set();
    for (const reference of codeReferences(node)) {
      const exists = nodeByName.has(reference.referencedNode);
      codeNodeReferences.push({
        codeNode: node.name,
        ...reference,
        exists,
        reachableBeforeCode: exists && isReachable(outgoing, reference.referencedNode, node.name),
        mustExecuteBefore: exists && mustExecuteBefore.has(reference.referencedNode),
      });
    }
  }

  return {
    nodes: nodes.map((node) => ({
      name: node?.name,
      type: node?.type,
      executionContract: execution.contracts.get(node?.name),
      mustExecuteBefore: [...(execution.mustBefore.get(node?.name) || [])].sort(),
      outgoing: outgoing.get(node?.name) || [],
      incoming: incoming.get(node?.name) || [],
    })),
    codeNodeReferences,
  };
}

function validateCodeDataflow(summary) {
  const errors = [];
  for (const reference of summary.codeNodeReferences) {
    if (!reference.exists) {
      errors.push(`Code node '${reference.codeNode}' references missing node '${reference.referencedNode}'`);
    } else if (!reference.reachableBeforeCode) {
      errors.push(`Code node '${reference.codeNode}' references '${reference.referencedNode}', which cannot reach it before execution`);
    } else if (!reference.mustExecuteBefore) {
      errors.push(`Code node '${reference.codeNode}' references '${reference.referencedNode}', which is reachable but not guaranteed to execute before it; an any-input branch may trigger the Code node first`);
    }
  }
  return errors;
}

function reconcileSemanticReview(review, summary) {
  const warnings = [];
  const blockingIssues = [];
  for (const issue of review.issues) {
    const evidence = issue.evidence;
    if (!evidence || typeof evidence !== 'object') {
      warnings.push(`Semantic review warning ignored because it has no structural evidence: ${issue.message}`);
      continue;
    }
    if (evidence.kind === 'code_dataflow') {
      const matchingReference = summary.codeNodeReferences.find((reference) => (
        reference.codeNode === evidence.code_node
        && reference.referencedNode === evidence.referenced_node
      ));
      if (matchingReference?.exists && matchingReference.mustExecuteBefore) {
        warnings.push(`Semantic review warning conflicts with verified dataflow (${evidence.referenced_node} -> ${evidence.code_node}): ${issue.message}`);
        continue;
      }
    }
    blockingIssues.push(issue);
  }
  return {
    verdict: blockingIssues.length ? 'revise' : 'pass',
    issues: blockingIssues,
    warnings,
    repairInstruction: blockingIssues.length ? review.repairInstruction : '',
  };
}

module.exports = {
  buildWorkflowDataflowSummary,
  validateCodeDataflow,
  reconcileSemanticReview,
};
