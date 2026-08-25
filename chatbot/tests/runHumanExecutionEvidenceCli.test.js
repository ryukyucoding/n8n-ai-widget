'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createExactExecutionReader,
  exactExecutionPath,
  runCli,
  writeReport,
} = require('./runHumanExecutionEvidenceCli');

function execution(items, overrides = {}) {
  return {
    id: 'execution-1',
    workflowId: 'workflow-1',
    finished: true,
    status: 'success',
    data: {
      resultData: {
        lastNodeExecuted: 'private-final-node',
        runData: { 'private-final-node': [{ data: { main: [items] } }] },
      },
    },
    ...overrides,
  };
}

function cliArgs() {
  return ['--workflowId', 'workflow-1', '--executionId', 'execution-1'];
}

test('mock exact-ID success returns only a human-ui de-identified report', async () => {
  let receivedExecutionId = null;
  const report = await runCli({
    argv: cliArgs(),
    readExecution: async (executionId) => {
      receivedExecutionId = executionId;
      return execution([{ json: { id: 1, title: 'raw-title' } }]);
    },
  });
  assert.equal(receivedExecutionId, 'execution-1');
  assert.deepEqual(report, {
    caseId: 'C01', status: 'pass', executionTrigger: 'human_ui', cleanup: { eligible: false },
    assertion: { findingCount: 0, findingCategories: {} },
  });
});

test('HTTP error from the exact reader is skipped', async () => {
  const reader = createExactExecutionReader({
    workflowId: 'workflow-1',
    requestExactExecution: async () => ({ status: 503, execution: { ignored: true } }),
  });
  const report = await runCli({ argv: cliArgs(), readExecution: reader });
  assert.equal(report.status, 'skipped');
});

test('returned execution ID or workflow ID mismatch is skipped', async () => {
  const wrongExecution = await runCli({
    argv: cliArgs(),
    readExecution: createExactExecutionReader({
      workflowId: 'workflow-1',
      requestExactExecution: async () => ({ status: 200, execution: execution([], { id: 'other-execution' }) }),
    }),
  });
  const wrongWorkflow = await runCli({
    argv: cliArgs(),
    readExecution: createExactExecutionReader({
      workflowId: 'workflow-1',
      requestExactExecution: async () => ({ status: 200, execution: execution([], { workflowId: 'other-workflow' }) }),
    }),
  });
  assert.equal(wrongExecution.status, 'skipped');
  assert.equal(wrongWorkflow.status, 'skipped');
});

test('unfinished execution and unsafe final wrapper shape are skipped', async () => {
  const unfinished = await runCli({
    argv: cliArgs(),
    readExecution: createExactExecutionReader({
      workflowId: 'workflow-1',
      requestExactExecution: async () => ({ status: 200, execution: execution([], { finished: false, status: 'running' }) }),
    }),
  });
  const unsafeOutput = await runCli({
    argv: cliArgs(),
    readExecution: createExactExecutionReader({
      workflowId: 'workflow-1',
      requestExactExecution: async () => ({ status: 200, execution: execution([{ id: 1, title: 'outer-only', json: null }]) }),
    }),
  });
  assert.equal(unfinished.status, 'skipped');
  assert.equal(unsafeOutput.status, 'skipped');
});

test('the production route is one exact GET path and CLI accepts no list/search input', () => {
  assert.equal(exactExecutionPath('execution-1'), '/api/v1/executions/execution-1?includeData=true');
  assert.equal(exactExecutionPath('bad/id'), null);
  assert.equal(runCli.constructor.name, 'AsyncFunction');
  assert.equal(require('./runHumanExecutionEvidenceCli').parseCliArgs(['--workflowId', 'workflow-1', '--search', 'latest']), null);
});

test('assertion mismatch fails and stdout serialization cannot contain raw execution data', async () => {
  const report = await runCli({
    argv: cliArgs(),
    readExecution: async () => execution([{
      json: { id: 'wrong-kind', title: 'raw-title-must-not-leak', token: 'secret-value-must-not-leak' },
    }]),
  });
  let stdout = '';
  writeReport(report, (line) => { stdout += line; });
  assert.equal(report.status, 'fail');
  assert.doesNotMatch(stdout, /workflow-1|execution-1|private-final-node|raw-title|secret-value|token|jsonplaceholder/i);
  assert.doesNotMatch(stdout, /"data"|"runData"/);
  assert.match(stdout, /"executionTrigger":"human_ui"/);
});
