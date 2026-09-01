'use strict';

const { sendRequest } = require('./task-client');
const { agentIdFromEnvironment } = require('./task-status');

function request(agentId) {
  if (!agentId) throw new Error('A2A_AGENT_ID is required to read an inbox');
  return {
    jsonrpc: '2.0',
    id: `agent-inbox-${Date.now()}`,
    method: 'ListInbox',
    params: { agentId },
  };
}

async function main(environment = process.env) {
  const response = await sendRequest({
    token: environment.A2A_BROKER_TOKEN,
    request: request(agentIdFromEnvironment(environment)),
  });
  const tasks = response.result || [];
  if (tasks.length === 0) {
    process.stdout.write('No submitted tasks for this agent.\n');
    return;
  }
  for (const task of tasks) {
    const latest = task.messages.at(-1);
    process.stdout.write(`TASK_ID: ${task.id}\nTYPE: ${task.taskType}\nINSTRUCTION:\n${latest.text}\n\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { request };
