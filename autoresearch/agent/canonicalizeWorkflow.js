'use strict';

// The Python validator owns workflow normalization and node-type alignment.
// This adapter keeps the canonical JSON inside the local runner process; it
// never serializes a workflow into a report, log, or tool result.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PYTHON_SOURCE = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from workflow_repair import canonicalize_workflow, validate_connection_ports, StructuredValidationError',
  'envelope = json.loads(sys.stdin.read())',
  'workflow = canonicalize_workflow(json.dumps(envelope["workflow"]), user_request=envelope.get("userRequest", ""))',
  // Normalize only ports for which the installed runtime proves one compatible
  // index. Ambiguous ports remain findings for the later authoritative check.
  'try: validate_connection_ports(workflow)',
  'except StructuredValidationError: pass',
  'print(json.dumps(workflow, ensure_ascii=False))',
].join('; ');

function canonicalizeWorkflow({ workflow, userRequest, python = process.env.PYTHON_BIN || 'python3', spawn = spawnSync, repairDirectory = path.join(__dirname, '..', '..', 'chatbot', 'python') } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow must be an object');
  const child = spawn(python, ['-c', PYTHON_SOURCE, repairDirectory], {
    input: JSON.stringify({ workflow, userRequest: typeof userRequest === 'string' ? userRequest : '' }),
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
    maxBuffer: 48 * 1024 * 1024,
    timeout: 30000,
  });
  if (child.error || child.status !== 0) throw new Error('canonicalization_failed');
  try {
    const canonical = JSON.parse(String(child.stdout || '').trim());
    if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) throw new Error('invalid canonical workflow');
    return canonical;
  } catch {
    throw new Error('canonicalization_failed');
  }
}

module.exports = { canonicalizeWorkflow, PYTHON_SOURCE };
