'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const directory = __dirname;
const read = (name) => fs.readFileSync(path.join(directory, name), 'utf8');

test('on-call dispatcher is narrow, bounded, and non-overlapping', () => {
  const script = read('debugger-oncall.sh');
  assert.match(script, /TASK_TYPE="sanitized_failure_diagnosis"/);
  assert.match(script, /RESOURCE_CLASS="model-inference"/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /deferred_interactive_codex_active/);
  assert.match(script, /timeout 300/);
  assert.match(script, /--sandbox read-only/);
  assert.match(script, /--ephemeral/);
  assert.match(script, /--ignore-user-config/);
  assert.match(script, /--ignore-rules/);
});

test('on-call units are event-driven and low priority', () => {
  const service = read('autoresearch-debugger-oncall.service');
  const pathUnit = read('autoresearch-debugger-oncall.path');
  const timer = read('autoresearch-debugger-oncall.timer');
  assert.match(pathUnit, /PathChanged=.*tasks\.json/);
  assert.match(service, /Nice=15/);
  assert.match(service, /IOSchedulingClass=idle/);
  assert.match(service, /CPUQuota=25%/);
  assert.match(service, /MemoryMax=2G/);
  assert.match(timer, /OnUnitInactiveSec=15min/);
});
