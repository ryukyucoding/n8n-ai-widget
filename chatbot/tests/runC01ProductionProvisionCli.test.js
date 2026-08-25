'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CODE_LEVEL_C01_PROVISION_ENABLED, main, parseCliArgs } = require('./runC01ProductionProvisionCli');

test('production provision CLI is code-disabled by default and accepts no content-changing argv', async () => {
  assert.equal(CODE_LEVEL_C01_PROVISION_ENABLED, false);
  assert.deepEqual(parseCliArgs([]), {});
  for (const argv of [
    ['--workflow', 'private-test-marker'],
    ['--case', 'C07'],
    ['--url', 'private-test-marker'],
    ['--confirm', 'private-test-marker'],
  ]) {
    assert.equal(parseCliArgs(argv), null);
  }
  let requests = 0;
  const result = await main({
    argv: [],
    environment: { C01_PROVISION_ONE_SHOT_CONFIRMATION: 'C01_PROVISION_ONCE' },
    fetchImpl: async () => { requests += 1; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(requests, 0);
});
