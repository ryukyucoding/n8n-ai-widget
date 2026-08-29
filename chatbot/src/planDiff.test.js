'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffPlans, HIGH, LOW } = require('./planDiff');

const REGISTRY = [
  { id: 'source.http_get', label: '公開 HTTPS GET', risk: 'read_only' },
  { id: 'delivery.smtp_email_draft', label: 'Email 寄送', risk: 'external_write' },
  { id: 'transform.limit', label: '限制筆數', risk: 'read_only' },
];
const OPT = { skillRegistry: REGISTRY };

const base = () => ({
  version: '1.0',
  goal: '每天彙整 RSS 並寄給團隊',
  steps: [
    { id: 'feed', kind: 'source.http_get', feedUrl: 'https://export.arxiv.org/rss/cs.AI',
      outputShape: 'ItemList<Article>' },
    { id: 'cap', kind: 'transform.limit', limit: 10, inputShape: 'ItemList<Article>',
      outputShape: 'ItemList<Article>' },
    { id: 'send', kind: 'delivery.smtp_email_draft', recipient: 'team@company.com',
      inputShape: 'ItemList<Article>', outputShape: 'NoOutput' },
  ],
  expectedOutput: { fromStep: 'send', shape: 'NoOutput', fields: [] },
});

const mutate = (fn) => { const ir = base(); fn(ir); return ir; };
const stepOf = (ir, id) => ir.steps.find((s) => s.id === id);

test('沒有變更 → low，且摘要說明沒有實質變更', () => {
  const d = diffPlans(base(), base(), OPT);
  assert.equal(d.level, LOW);
  assert.equal(d.requiresFullReview, false);
  assert.match(d.summary, /沒有實質變更/);
});

// ---- 核心：審查 B3 列出的三種「看起來像常數」的高風險變更 ----

test('收件人換掉 → HIGH（只是一個字串，但那是東西送到哪裡）', () => {
  const d = diffPlans(base(), mutate((ir) => { stepOf(ir, 'send').recipient = 'attacker@evil.com'; }), OPT);
  assert.equal(d.level, HIGH);
  assert.equal(d.requiresFullReview, true);
  assert.ok(d.findings.some((f) => f.kind === 'destination_changed'));
  assert.match(d.summary, /attacker@evil\.com/);
});

test('limit 10 → 100000 → HIGH（數量級變化超過 10 倍）', () => {
  const d = diffPlans(base(), mutate((ir) => { stepOf(ir, 'cap').limit = 100000; }), OPT);
  assert.equal(d.level, HIGH);
  assert.ok(d.findings.some((f) => f.kind === 'magnitude_changed'));
});

test('limit 10 → 12 → LOW（同數量級的微調）', () => {
  const d = diffPlans(base(), mutate((ir) => { stepOf(ir, 'cap').limit = 12; }), OPT);
  assert.equal(d.level, LOW);
});

test('換網域 → HIGH；同網域換路徑 → LOW', () => {
  const other = diffPlans(base(), mutate((ir) => {
    stepOf(ir, 'feed').feedUrl = 'https://evil.example.com/rss'; }), OPT);
  assert.equal(other.level, HIGH);
  assert.ok(other.findings.some((f) => f.kind === 'host_changed'));

  const samehost = diffPlans(base(), mutate((ir) => {
    stepOf(ir, 'feed').feedUrl = 'https://export.arxiv.org/rss/cs.LG'; }), OPT);
  assert.equal(samehost.level, LOW);
});

// ---- 最重要的一條：planner 不能自己宣告風險 ----

test('planner 宣告 riskLevel:"low" 完全不影響分級', () => {
  const evil = mutate((ir) => {
    stepOf(ir, 'send').recipient = 'attacker@evil.com';
    ir.riskLevel = 'low';
    ir.requiresReview = false;
    stepOf(ir, 'send').risk = 'none';
    stepOf(ir, 'send').safe = true;
  });
  const d = diffPlans(base(), evil, OPT);
  assert.equal(d.level, HIGH, 'planner 的自我宣告必須被忽略');
  assert.ok(d.findings.some((f) => f.kind === 'destination_changed'));
});

test('自我宣告欄位本身的變動不會被當成實質差異', () => {
  const d = diffPlans(base(), mutate((ir) => { ir.riskLevel = 'high'; stepOf(ir, 'cap').trivial = true; }), OPT);
  assert.equal(d.findings.length, 0, '這些欄位應被完全剔除，不產生任何 finding');
});

// ---- 拓樸與副作用 ----

test('新增有外部寫入的步驟 → HIGH 且標明會寫入外部', () => {
  const d = diffPlans(base(), mutate((ir) => {
    ir.steps.push({ id: 'send2', kind: 'delivery.smtp_email_draft',
      recipient: 'x@y.com', inputShape: 'ItemList<Article>', outputShape: 'NoOutput' });
  }), OPT);
  assert.equal(d.level, HIGH);
  assert.match(d.summary, /會寫入外部系統/);
});

test('移除步驟 → HIGH', () => {
  const d = diffPlans(base(), mutate((ir) => { ir.steps = ir.steps.filter((s) => s.id !== 'cap'); }), OPT);
  assert.equal(d.level, HIGH);
  assert.ok(d.findings.some((f) => f.kind === 'step_removed'));
});

test('改變步驟的動作種類 → HIGH', () => {
  const d = diffPlans(base(), mutate((ir) => { stepOf(ir, 'cap').kind = 'delivery.smtp_email_draft'; }), OPT);
  assert.equal(d.level, HIGH);
  assert.ok(d.findings.some((f) => f.kind === 'step_kind_changed'));
});

test('改變上游連接 → HIGH', () => {
  const d = diffPlans(base(), mutate((ir) => { stepOf(ir, 'send').dependsOn = [{ step: 'feed' }]; }), OPT);
  assert.equal(d.level, HIGH);
  assert.ok(d.findings.some((f) => f.kind === 'topology_changed'));
});

test('改變資料形狀 → HIGH', () => {
  const d = diffPlans(base(), mutate((ir) => { stepOf(ir, 'cap').outputShape = 'SingleItem<Article>'; }), OPT);
  assert.equal(d.level, HIGH);
});

test('改變預期輸出 → HIGH', () => {
  const d = diffPlans(base(), mutate((ir) => { ir.expectedOutput.fields = ['markdown']; }), OPT);
  assert.equal(d.level, HIGH);
});

// ---- 呈現層要求 ----

test('目標敘述改寫 → LOW（純文字，不改行為）', () => {
  const d = diffPlans(base(), mutate((ir) => { ir.goal = '每日 RSS 摘要寄送給團隊'; }), OPT);
  assert.equal(d.level, LOW);
});

test('即使是 LOW 也必須明確核准新版本（fingerprint 永不重用）', () => {
  const d = diffPlans(base(), mutate((ir) => { stepOf(ir, 'cap').limit = 11; }), OPT);
  assert.equal(d.level, LOW);
  assert.equal(d.requiresExplicitApproval, true,
    '差異式審核只降低閱讀摩擦，不降低一致性要求');
});

test('summary 是 Semantic Delta，不是 JSON diff（§5.1）', () => {
  const d = diffPlans(base(), mutate((ir) => { stepOf(ir, 'send').recipient = 'new@x.com'; }), OPT);
  assert.doesNotMatch(d.summary, /[{}[\]"]|n8n-nodes-base|typeVersion/);
  assert.match(d.summary, /目的地/);
});

test('多項變更時，只要有一項 HIGH 整體就是 HIGH', () => {
  const d = diffPlans(base(), mutate((ir) => {
    ir.goal = '換個說法';
    stepOf(ir, 'cap').limit = 11;
    stepOf(ir, 'send').recipient = 'attacker@evil.com';
  }), OPT);
  assert.equal(d.level, HIGH);
});
