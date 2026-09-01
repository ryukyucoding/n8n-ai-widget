'use strict';

const { readReply, parseArgs } = require('./reply-task');
const { sendRequest } = require('./task-client');
const { agentIdFromEnvironment } = require('./task-status');

async function getTask(taskId, environment) {
  const response = await sendRequest({
    token: environment.A2A_BROKER_TOKEN,
    request: { jsonrpc: '2.0', id: `get-task-${Date.now()}`, method: 'GetTask', params: { taskId } },
  });
  if (!response.result) throw new Error('broker did not return the task');
  return response.result;
}

function completionRequest(task, agentId, text) {
  if (task.assigneeAgentId !== agentId) throw new Error('only the assigned agent may complete this task');
  return {
    jsonrpc: '2.0',
    id: `complete-task-${Date.now()}`,
    method: 'SendMessage',
    params: {
      taskId: task.id,
      senderAgentId: agentId,
      assigneeAgentId: agentId,
      executionHost: task.executionHost,
      resourceClass: task.resourceClass,
      taskType: task.taskType,
      state: 'completed',
      text,
    },
  };
}

async function main(args = process.argv.slice(2), environment = process.env) {
  const { taskId, replyPath } = parseArgs(args);
  const agentId = agentIdFromEnvironment(environment);
  if (!agentId) throw new Error('A2A_AGENT_ID is required to complete a task');
  const task = await getTask(taskId, environment);
  const response = await sendRequest({
    token: environment.A2A_BROKER_TOKEN,
    request: completionRequest(task, agentId, readReply(replyPath)),
  });
  process.stdout.write(`Task ${response.result.id} completed.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { getTask, completionRequest };
