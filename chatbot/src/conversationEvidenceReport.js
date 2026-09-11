'use strict';

const fs = require('node:fs');
const { DEFAULT_EVIDENCE_PATH } = require('./conversationEvidence');

const filePath = process.env.CONVERSATION_EVIDENCE_PATH || DEFAULT_EVIDENCE_PATH;
const MAX_EVENTS = 200;

function main() {
  if (!fs.existsSync(filePath)) {
    process.stdout.write(JSON.stringify({ evidenceFile: filePath, events: [] }) + '\n');
    return;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const events = [];
  for (const line of lines.slice(-MAX_EVENTS)) {
    try { events.push(JSON.parse(line)); } catch (_) { /* ignore a partial final line */ }
  }
  process.stdout.write(JSON.stringify({ evidenceFile: filePath, events }) + '\n');
}

if (require.main === module) main();

module.exports = { main };
