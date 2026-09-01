'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const nodeTest = require('node:test');
const assert = require('node:assert/strict');

nodeTest('compiler corpus runner resolves its checked-in corpus from the chatbot runtime directory', () => {
  const chatbotDir = path.join(__dirname, '..');
  const output = execFileSync(
    process.execPath,
    [path.join(chatbotDir, 'tools', 'runPlannerCorpus.js'), '--level', 'compiler'],
    { cwd: chatbotDir, encoding: 'utf8' },
  );

  const summary = JSON.parse(output);
  assert.equal(summary.label, 'compiler');
  assert.equal(summary.rate, 1);
  assert.ok(summary.byGroup.compiler_reject.total > 0);
});
