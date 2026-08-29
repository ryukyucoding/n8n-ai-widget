'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeDigest, stableStringify, schemaRevision, assessFreshness, approvalStillValid,
} = require('./runtimeSchemaRevision');

const NODES = { 'n8n-nodes-base.set': { versions: { 3: { name: 'set' } } } };
const snap = (over = {}) => ({
  format: 1, generatedAt: '2026-08-28T00:00:00.000Z', n8nVersion: '1.62.0',
  nodeTypes: NODES, ...over,
});

test('digest 只反映內容，不反映鍵的插入順序', () => {
  const a = { x: 1, y: { p: 1, q: 2 } };
  const b = { y: { q: 2, p: 1 }, x: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(computeDigest(a), computeDigest(b), '同內容不同鍵序必須得到同一 digest');
});

test('內容改變時 digest 必須改變', () => {
  assert.notEqual(computeDigest(NODES),
    computeDigest({ 'n8n-nodes-base.set': { versions: { 4: { name: 'set' } } } }));
});

test('revision 綁 digest 而非時間戳：重抓但內容沒變，revision 不變', () => {
  const first = schemaRevision(snap({ generatedAt: '2026-08-01T00:00:00.000Z' }));
  const again = schemaRevision(snap({ generatedAt: '2026-08-28T00:00:00.000Z' }));
  assert.equal(first.revision, again.revision,
    '無實質變更的重抓不該讓所有 approval 失效');
});

test('n8n 升級時 revision 改變', () => {
  assert.notEqual(schemaRevision(snap()).revision,
    schemaRevision(snap({ n8nVersion: '1.63.0' })).revision);
});

test('舊快照缺 nodeTypesDigest 時就地重算，不必等 export 工具重跑', () => {
  const r = schemaRevision({ generatedAt: '2026-07-22T00:00:00Z', nodeTypes: NODES });
  assert.equal(r.digestWasRecomputed, true);
  assert.equal(r.n8nVersion, null);
  assert.match(r.revision, /^unknown\+[0-9a-f]{16}$/);
});

test('freshness：容許期內為 fresh', () => {
  const r = assessFreshness(snap(), { now: new Date('2026-08-29T00:00:00Z') });
  assert.equal(r.status, 'fresh');
});

test('freshness：超過容許期為 stale，且訊息說明後果', () => {
  const r = assessFreshness(snap({ generatedAt: '2026-07-22T00:00:00Z' }),
    { now: new Date('2026-08-28T00:00:00Z') });
  assert.equal(r.status, 'stale');
  assert.ok(Math.round(r.ageHours / 24) === 37);
  assert.match(r.findings.join(' '), /只對舊 runtime 成立/);
});

test('freshness：缺 generatedAt 時是 unknown，不是 fresh', () => {
  const r = assessFreshness({ nodeTypes: NODES, n8nVersion: '1.62.0' });
  assert.equal(r.status, 'unknown', '不知道就要說不知道，不得默默當成沒事');
});

test('freshness：generatedAt 無法解析時是 unknown', () => {
  assert.equal(assessFreshness(snap({ generatedAt: 'nonsense' })).status, 'unknown');
});

test('freshness：時間戳在未來是 unknown，不是 fresh', () => {
  const r = assessFreshness(snap(), { now: new Date('2026-08-27T00:00:00Z') });
  assert.equal(r.status, 'unknown');
  assert.match(r.findings.join(' '), /時鐘不同步/);
});

test('freshness：缺 n8nVersion 一律回報，即使時間是新的', () => {
  const r = assessFreshness(snap({ n8nVersion: null }), { now: new Date('2026-08-28T01:00:00Z') });
  assert.equal(r.status, 'fresh');
  assert.match(r.findings.join(' '), /沒有記錄 n8n 版本/);
});

test('approval：schema 未變時仍然有效', () => {
  const rev = schemaRevision(snap()).revision;
  assert.equal(approvalStillValid(rev, snap()).valid, true);
});

test('approval：schema 變更後失效，理由引用規格 §10 第 2 題', () => {
  const rev = schemaRevision(snap()).revision;
  const r = approvalStillValid(rev, snap({ n8nVersion: '1.63.0' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /舊核准不得用於編譯/);
});

test('approval：核准後只是重抓（內容沒變）不該失效', () => {
  const rev = schemaRevision(snap({ generatedAt: '2026-08-01T00:00:00Z' })).revision;
  assert.equal(approvalStillValid(rev, snap({ generatedAt: '2026-08-28T00:00:00Z' })).valid, true);
});

test('實際快照：確實被判為 stale 且缺版本錨點', () => {
  const real = require('../schemas/runtime_node_schemas.json');
  const r = assessFreshness(real, { now: new Date('2026-08-28T06:00:00Z') });
  assert.equal(r.status, 'stale');
  assert.match(r.findings.join(' '), /沒有記錄 n8n 版本/);
  assert.equal(schemaRevision(real).n8nVersion, null);
});
