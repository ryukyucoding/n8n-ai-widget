'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const {
  QUARANTINED_SOURCE,
  QUARANTINED_PLANNER_CORPUS,
  assertCorpusArtifactAllowed,
} = require('../tools/corpusQuarantine');

nodeTest('planner corpus runner refuses its quarantined checked-in corpus before reading records', () => {
  const chatbotDir = path.join(__dirname, '..');
  assert.throws(
    () => execFileSync(
      process.execPath,
      [path.join(chatbotDir, 'tools', 'runPlannerCorpus.js'), '--level', 'compiler'],
      { cwd: chatbotDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ),
    (error) => error && error.status !== 0,
  );
});

nodeTest('refuses security-quarantined raw and derived corpus artifacts without reading records', () => {
  assert.throws(
    () => assertCorpusArtifactAllowed(QUARANTINED_SOURCE),
    /security-quarantined/,
  );
  assert.throws(
    () => assertCorpusArtifactAllowed(QUARANTINED_PLANNER_CORPUS),
    /security-quarantined/,
  );
});

nodeTest('Easy-100 audit command refuses the quarantined source before creating output', () => {
  const output = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'corpus-audit-')), 'report.json');
  assert.throws(
    () => execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'tools', 'audit_easy100_capability_coverage.js'), '--input', QUARANTINED_SOURCE, '--output', output],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ),
    (error) => error && error.status !== 0,
  );
  assert.equal(fs.existsSync(output), false);
});

nodeTest('planner corpus builder refuses the quarantined source before creating output', () => {
  const output = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'corpus-build-')), 'planner.json');
  assert.throws(
    () => execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'tools', 'buildPlannerCorpus.js'), '--easy100', QUARANTINED_SOURCE, '--output', output],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ),
    (error) => error && error.status !== 0,
  );
  assert.equal(fs.existsSync(output), false);
});
