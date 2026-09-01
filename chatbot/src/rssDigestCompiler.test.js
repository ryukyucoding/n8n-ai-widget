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

// --- R3（第二處）：feedUrl 的 SSRF 防線 ---
// 沿用既有 fixture 當基底，只覆寫 feedUrl，避免與原測試的 spec 結構脫節。

for (const [bad, label] of [
  ['https://169.254.169.254/feed.xml', '雲端 metadata'],
  ['https://127.0.0.1:5678/feed.xml', 'n8n 自己的 API'],
  ['https://10.0.0.5/feed.xml', 'RFC1918'],
  ['https://[::ffff:127.0.0.1]/feed.xml', 'IPv4-mapped 繞過'],
  ['https://intranet/feed.xml', '單標籤主機名'],
  ['https://news.local/feed.xml', '內部網域後綴'],
  ['https://export.arxiv.org:8443/rss/cs.AI', '非標準 port'],
]) {
  test(`feedUrl 阻擋：${label}`, () => {
    const spec = specification();
    spec.feedUrl = bad;
    assert.throws(() => compileDailyRssDigestSpecification(spec),
      /feedUrl 未通過 public URL 政策/, `${bad} 應被擋下`);
  });
}

test('feedUrl 放行任意公開 feed（使用者自訂，不套 allowlist）', () => {
  for (const url of ['https://example.com/feed.xml', 'https://news.ycombinator.com/rss']) {
    const spec = specification();
    spec.feedUrl = url;
    assert.doesNotThrow(() => compileDailyRssDigestSpecification(spec));
  }
});
