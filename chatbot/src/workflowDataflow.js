'use strict';

const CODE_REFERENCE_PATTERN = /\$\(\s*(['\"])([^'\"\n]+)\1\s*\)\s*\.\s*(first|all|item|itemMatching)\s*\(/g;

const INPUT_ALL_PATTERN = '\\$input\\s*\\.\\s*all\\s*\\(\\s*\\)';
const ITERATION_METHOD_PATTERN = '(?:filter|map|forEach|some|every|find|reduce)';
const WRAPPER_METADATA_FIELDS = new Set(['json', 'binary', 'pairedItem']);

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


function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

// Deliberately narrow lexical masking: comments and quoted literals cannot
// create wrapper findings. The guard does not attempt full JavaScript parsing.
function maskNonCode(source) {
  const masked = source.split('');
  const blank = (start, end) => {
    for (let cursor = start; cursor < end; cursor += 1) if (masked[cursor] !== '\n') masked[cursor] = ' ';
  };
  const previousSignificant = (at) => {
    for (let cursor = at - 1; cursor >= 0; cursor -= 1) {
      if (!/\s/.test(masked[cursor])) return masked[cursor];
    }
    return '';
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(index, end);
      index = end - 1;
    } else if (char === '\'' || char === '"' || char.charCodeAt(0) === 96) {
      const quote = char;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') cursor += 2;
        else if (source[cursor] === quote) {
          cursor += 1;
          break;
        } else cursor += 1;
      }
      blank(index, cursor);
      index = cursor - 1;
    } else if (char === '/' && /[([{:;,=!?&|>]/.test(previousSignificant(index))) {
      let cursor = index + 1;
      let characterClass = false;
      while (cursor < source.length) {
        if (source[cursor] === '\\') cursor += 2;
        else if (source[cursor] === '[') {
          characterClass = true;
          cursor += 1;
        } else if (source[cursor] === ']') {
          characterClass = false;
          cursor += 1;
        } else if (source[cursor] === '/' && !characterClass) {
          cursor += 1;
          while (/[a-z]/i.test(source[cursor] || '')) cursor += 1;
          break;
        } else cursor += 1;
      }
      blank(index, cursor);
      index = cursor - 1;
    }
  }
  return masked.join('');
}

function balancedBlockEnd(code, start) {
  if (code[start] !== '{') return null;
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    if (code[index] === '}' && --depth === 0) return index + 1;
  }
  return null;
}

function callbackBodyRange(code, start) {
  while (/\s/.test(code[start] || '')) start += 1;
  if (code[start] === '{') {
    const end = balancedBlockEnd(code, start);
    return end === null ? null : { start, end };
  }
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return { start, end: index };
      depth -= 1;
    } else if (char === ',' && depth === 0) return { start, end: index };
  }
  return null;
}

function wrapperItemAccesses(node) {
  const jsCode = node?.parameters?.jsCode;
  if (typeof jsCode !== 'string') return [];
  const code = maskNonCode(jsCode);
  const collections = new Set();
  const declaration = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*' + INPUT_ALL_PATTERN + '(?!\\s*\\.)', 'g');
  for (let match = declaration.exec(code); match; match = declaration.exec(code)) collections.add(match[1]);

  const sources = [INPUT_ALL_PATTERN, ...[...collections].map(escapeRegex)];
  const scopes = [];
  const callback = new RegExp('(?:' + sources.join('|') + ')\\s*\\.\\s*' + ITERATION_METHOD_PATTERN + '\\s*\\(\\s*(?:\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)|([A-Za-z_$][\\w$]*))\\s*=>', 'g');
  for (let match = callback.exec(code); match; match = callback.exec(code)) {
    const range = callbackBodyRange(code, callback.lastIndex);
    if (range) scopes.push({ variable: match[1] || match[2], ...range });
  }
  if (collections.size) {
    const forOf = new RegExp('\\bfor\\s*\\(\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+(?:' + [...collections].map(escapeRegex).join('|') + ')\\s*\\)\\s*', 'g');
    for (let match = forOf.exec(code); match; match = forOf.exec(code)) {
      let start = forOf.lastIndex;
      while (/\s/.test(code[start] || '')) start += 1;
      const end = balancedBlockEnd(code, start);
      if (end !== null) scopes.push({ variable: match[1], start, end });
    }
  }

  const accesses = [];
  for (const scope of scopes) {
    const propertyRead = new RegExp('(?:^|[^A-Za-z0-9_$])' + escapeRegex(scope.variable) + '\\s*(?:\\.|\\?\\.)\\s*([A-Za-z_$][\\w$]*)', 'g');
    const body = code.slice(scope.start, scope.end);
    for (let match = propertyRead.exec(body); match; match = propertyRead.exec(body)) {
      if (!WRAPPER_METADATA_FIELDS.has(match[1])) {
        accesses.push({ codeNode: node.name });
        break;
      }
    }
  }
  return accesses;
}

function buildWorkflowDataflowSummary(workflow, options = {}) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const nodeByName = new Map(nodes.filter((node) => node && typeof node.name === 'string')
    .map((node) => [node.name, node]));
  const { outgoing, incoming } = connectionsFrom(workflow || {});
  const execution = computeMustExecuteBefore(nodes, incoming, options.runtimeSchemas);
  const codeNodeReferences = [];
  const codeNodeWrapperItemAccesses = [];

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
    codeNodeWrapperItemAccesses.push(...wrapperItemAccesses(node));
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
    codeNodeWrapperItemAccesses,
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
  for (const access of summary.codeNodeWrapperItemAccesses || []) {
    errors.push("Code node '" + access.codeNode + "' reads a $input.all() item as a payload object; read payload fields through item.json");
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
