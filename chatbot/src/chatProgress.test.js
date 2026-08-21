'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8');

function extractProgressHelper() {
  const start = source.indexOf('async function generateWithProgress');
  assert.notEqual(start, -1);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('progress helper is unclosed');
}

function harness(lines) {
  const calls = [];
  const updates = [];
  const encoder = new TextEncoder();
  let index = 0;
  const context = {
    GENERATE_URL: '/generate',
    TextDecoder,
    setProgress: (_typing, message) => updates.push(message),
    fetch: async (url, request) => {
      calls.push({ url, request });
      return {
        ok: true,
        headers: { get: () => 'application/x-ndjson' },
        body: { getReader: () => ({ read: async () => index < lines.length ? { done: false, value: encoder.encode(lines[index++]) } : { done: true } }) },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(extractProgressHelper() + '; this.run = generateWithProgress;', context);
  return { calls, updates, run: context.run };
}

nodeTest('Create sends stream:true, renders progress, ignores unknown events, and returns result', async () => {
  const h = harness([
    '{"event":"progress","message":"Planning"}\n{"event":"lifecycle"}\n',
    '{"event":"progress","message":"Generating"}\n{"event":"result","status":200,"data":{"message":"done"}}\n',
  ]);
  const result = await h.run({ message: 'safe test' }, {});
  assert.equal(h.calls[0].url, '/generate');
  assert.equal(JSON.parse(h.calls[0].request.body).stream, true);
  assert.deepEqual(h.updates, ['Planning', 'Generating']);
  assert.ok(source.indexOf('data = generated.data;') < source.indexOf('typing.remove();'));
  assert.equal(result.ok, true);
  assert.equal(result.data.message, 'done');
});

nodeTest('malformed NDJSON rejects and the existing error path removes typing', async () => {
  const h = harness(['{bad}\n']);
  await assert.rejects(() => h.run({ message: 'safe test' }, {}));
  assert.match(source, /catch \(err\) \{\r?\n\s*typing\.remove\(\);/);
});

nodeTest('Edit stays on the JSON agent request and draft handoff is absent', () => {
  assert.ok(source.includes('} else {\n          res = await fetch(AGENT_URL, {'));
  assert.doesNotMatch(source, /DRAFT_WORKFLOW_KEY|draft_needs_setup|draft_needs_repair|editHandoff|createDraftHandoff/);
});
