'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FILTER_FIXTURE_ID, buildFilterFixture, readbackChecks, executionChecks, runFilterFixture } = require('./filterAcceptanceRunner');

const fakeAst = { combinator: 'and', conditions: [{ leftValue: '={{ $json.completed }}', operator: { type: 'boolean', operation: 'equals' }, rightValue: false }] };

test('filter fixture refuses to guess a missing condition AST', () => {
  assert.throws(() => buildFilterFixture(null), /never guess/);
  const workflow = buildFilterFixture(fakeAst);
  assert.equal(workflow.nodes.find((node) => node.type === 'n8n-nodes-base.filter').typeVersion, 2.3);
  assert.deepEqual(workflow.nodes.find((node) => node.type === 'n8n-nodes-base.filter').parameters.conditions, fakeAst);
});

test('readback checks require exact AST and one linear output', () => {
  const workflow = buildFilterFixture(fakeAst);
  const checks = readbackChecks(workflow, fakeAst);
  assert.ok(Object.values(checks).every(Boolean));
  assert.equal(readbackChecks(workflow, { ...fakeAst, combinator: 'or' }).condition_ast_exact, false);
  const branched = { ...workflow, connections: { ...workflow.connections, 'Filter Completed': { main: [workflow.connections['Filter Completed'].main[0], [{ node: 'Discarded', type: 'main', index: 1 }]] } } };
  assert.equal(readbackChecks(branched, fakeAst).no_discarded_branch, false);
});

test('execution checks require filtered false rows and numeric final output', () => {
  assert.deepEqual(executionChecks({ executed: true, filteredItems: 9, allCompletedFalse: true, totalTodos: 9, incompleteTodos: 9 }), {
    executed: true, filtered_items_numeric: true, all_completed_false: true, final_total_numeric: true, final_incomplete_numeric: true,
  });
  assert.equal(executionChecks({ executed: true, filteredItems: 1, allCompletedFalse: false, totalTodos: 1, incompleteTodos: 0 }).all_completed_false, false);
});

test('runner creates, reads, executes, deactivates, and deletes only the fixed filter fixture', async () => {
  const calls = [];
  const api = {
    async createWorkflow(workflow) { calls.push(['create', workflow.name]); return { id: 'filter-wf' }; },
    async getWorkflow() { calls.push(['get']); return buildFilterFixture(fakeAst); },
    async executeFilterWebhook(id, fixture) { calls.push(['execute', id, fixture]); return { executed: true, filteredItems: 9, allCompletedFalse: true, totalTodos: 9, incompleteTodos: 9 }; },
    async deactivateWorkflow(id) { calls.push(['deactivate', id]); },
    async deleteWorkflow(id) { calls.push(['delete', id]); },
  };
  const result = await runFilterFixture({ api, conditionAst: fakeAst });
  assert.equal(result.fixture, FILTER_FIXTURE_ID);
  assert.equal(result.pass, true);
  assert.deepEqual(calls.map((call) => call[0]), ['create', 'get', 'execute', 'deactivate', 'delete']);
});

test('runner fails closed on execution error and still cleans up', async () => {
  const calls = [];
  const api = {
    async createWorkflow() { calls.push('create'); return { id: 'filter-wf' }; },
    async getWorkflow() { calls.push('get'); return buildFilterFixture(fakeAst); },
    async executeFilterWebhook() { calls.push('execute'); throw new Error('raw private response'); },
    async deactivateWorkflow() { calls.push('deactivate'); },
    async deleteWorkflow() { calls.push('delete'); },
  };
  const result = await runFilterFixture({ api, conditionAst: fakeAst });
  assert.equal(result.pass, false);
  assert.equal(result.failure.phase, 'execute');
  assert.deepEqual(calls, ['create', 'get', 'execute', 'deactivate', 'delete']);
  assert.doesNotMatch(JSON.stringify(result), /raw private response/);
});
