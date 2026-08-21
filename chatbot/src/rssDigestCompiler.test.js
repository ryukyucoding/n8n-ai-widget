'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { compileDailyRssDigestSpecification } = require('./rssDigestCompiler');

function specification() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'daily-rss-digest-spec.json'), 'utf8'));
}

test('compiles a scheduled RSS digest with bounded filtering, deduplication, and Markdown output', () => {
  const workflow = compileDailyRssDigestSpecification(specification());
  assert.deepEqual(workflow.nodes.map((node) => node.type), [
    'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.rssFeedRead',
    'n8n-nodes-base.code', 'n8n-nodes-base.limit', 'n8n-nodes-base.code',
  ]);
  assert.equal(workflow.nodes[2].parameters.url, 'https://export.arxiv.org/rss/cs.AI');
  assert.match(workflow.nodes[3].parameters.jsCode, /seenTitles/);
  assert.match(workflow.nodes[5].parameters.jsCode, /markdown/);
  assert.equal(Object.keys(workflow.connections).length, 5);
});

test('refuses a non-HTTPS feed URL before it can reach n8n', () => {
  const spec = specification();
  spec.feedUrl = 'http://example.test/feed.xml';
  assert.throws(() => compileDailyRssDigestSpecification(spec), /HTTPS/);
});

test('refuses an output contract that does not match the compiler-owned result', () => {
  const spec = specification();
  spec.expectedOutput.fields = ['markdown'];
  assert.throws(() => compileDailyRssDigestSpecification(spec), /expected output/);
});
