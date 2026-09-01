'use strict';

const { sendRequest } = require('./task-client');

function agentIdFromEnvironment(environment = process.env) {
  const agentId = environment.A2A_AGENT_ID;
  if (agentId !== undefined && !/^(orchestrator|evidence-researcher|experiment-engineer|execution-verifier|debugger)$/.test(agentId)) {
    throw new Error('A2A_AGENT_ID must be an allowlisted agent ID');
  }
  return agentId;
}

function request(agentId) {
  return {
    jsonrpc: '2.0',
    id: `task-status-${Date.now()}`,
    method: 'ListTaskSummaries',
    params: agentId ? { agentId } : {},
  };
}

async function main(environment = process.env) {
  const response = await sendRequest({ token: environment.A2A_BROKER_TOKEN, request: request(agentIdFromEnvironment(environment)) });
  process.stdout.write(`${JSON.stringify(response.result || [], null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { agentIdFromEnvironment, request };
