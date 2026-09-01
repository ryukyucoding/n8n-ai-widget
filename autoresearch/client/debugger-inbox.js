'use strict';

const { sendRequest } = require('./task-client');

function request() {
  return {
    jsonrpc: '2.0',
    id: `debugger-inbox-${Date.now()}`,
    method: 'ListInbox',
    params: { agentId: 'debugger' },
  };
}

async function main() {
  const response = await sendRequest({ request: request() });
  const tasks = response.result || [];
  if (tasks.length === 0) {
    process.stdout.write('No submitted debugger tasks.\n');
    return;
  }
  for (const task of tasks) {
    const latest = task.messages.at(-1);
    process.stdout.write(`TASK_ID: ${task.id}\nTYPE: ${task.taskType}\nFROM: ${latest.senderAgentId}\nINSTRUCTION:\n${latest.text}\n\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { request };
