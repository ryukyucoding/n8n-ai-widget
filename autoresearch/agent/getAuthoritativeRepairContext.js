'use strict';

// Ask the same Python code that blocks Create for a de-identified repair
// context. Workflow data remains only on the child-process stdin/stdout path.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PYTHON_SOURCE = [
  'import copy, json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from workflow_repair import canonicalize_workflow, validate_connection_ports, validate_node_parameters, StructuredValidationError',
  'envelope = json.loads(sys.stdin.read())',
  'canonical = canonicalize_workflow(json.dumps(envelope["workflow"]), user_request=envelope.get("userRequest", ""))',
  'findings = []',
  'try:',
  ' validate_node_parameters(canonical, envelope.get("userRequest", ""), include_repair_context=True)',
  'except StructuredValidationError as error:',
  ' findings = error.safe_findings',
  'try:',
  ' validate_connection_ports(copy.deepcopy(canonical), include_repair_context=True)',
  'except StructuredValidationError as error:',
  ' findings.extend(error.safe_findings)',
  'print(json.dumps({"findings": findings}, ensure_ascii=False))',
].join('\n');

function getAuthoritativeRepairContext({ workflow, userRequest, python = process.env.PYTHON_BIN || 'python3', spawn = spawnSync, repairDirectory = path.join(__dirname, '..', '..', 'chatbot', 'python') } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow must be an object');
  const child = spawn(python, ['-c', PYTHON_SOURCE, repairDirectory], {
    input: JSON.stringify({ workflow, userRequest: typeof userRequest === 'string' ? userRequest : '' }),
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
    maxBuffer: 48 * 1024 * 1024,
    timeout: 30000,
  });
  if (child.error || child.status !== 0) throw new Error('authoritative_repair_context_failed');
  try {
    const payload = JSON.parse(String(child.stdout || '').trim());
    if (!Array.isArray(payload?.findings)) throw new Error('invalid repair context');
    return payload.findings;
  } catch {
    throw new Error('authoritative_repair_context_failed');
  }
}

module.exports = { getAuthoritativeRepairContext, PYTHON_SOURCE };
