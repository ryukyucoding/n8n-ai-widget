'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sendRequest } = require('./task-client');

function usage() {
  return 'Usage: node autoresearch/client/reply-task.js --task <task-id> --reply <safe-reply.txt>';
}

function parseArgs(args) {
  if (args.length !== 4 || args[0] !== '--task' || args[2] !== '--reply') throw new Error(usage());
  if (!/^task_[a-f0-9-]+$/i.test(args[1])) throw new Error('task ID has an invalid format');
  return { taskId: args[1], replyPath: args[3] };
}

function readReply(replyPath) {
  const text = fs.readFileSync(path.resolve(replyPath), 'utf8').trim();
  if (!text) throw new Error('reply file must not be empty');
  return text;
}

async function main(args = process.argv.slice(2)) {
  const { taskId, replyPath } = parseArgs(args);
  const response = await sendRequest({
    request: {
      jsonrpc: '2.0',
      id: `debugger-reply-${Date.now()}`,
      method: 'SendMessage',
      params: {
        taskId,
        senderAgentId: 'debugger',
        assigneeAgentId: 'debugger',
        executionHost: 'server',
        resourceClass: 'light',
        taskType: 'sanitized_failure_diagnosis',
        state: 'completed',
        text: readReply(replyPath),
      },
    },
  });
  process.stdout.write(`Task ${response.result.id} completed.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, readReply };

