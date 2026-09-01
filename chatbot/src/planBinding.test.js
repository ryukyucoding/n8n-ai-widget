'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stableStringify, canonicalizeIr, computeFingerprint, renderPlan,
  issueApprovalToken, verifyApprovalToken, assertApprovedForCompilation,
} = require('./planBinding');

const SECRET = 'test-approval-secret-32-chars-ok';
const CTX = { runtimeSchemaRevision: '2.18.7+abc123', skillRegistryRevision: 'reg-1' };
const OPTS = { secret: SECRET, sessionId: 'sess-1' };

const ir = (over = {}) => ({
  version: '1.0',
  goal: '取得 user 2 的 todos 並輸出統計',
  steps: [
    { id: 'start', kind: 'trigger.manual', outputShape: 'SingleItem<Empty>' },
    { id: 'todos', kind: 'source.http_get', urlRef: 'https://jsonplaceholder.typicode.com/todos?userId=2',
      outputShape: 'ItemList<Todo>' },
  ],
  expectedOutput: { fromStep: 'todos', shape: 'ItemList<Todo>', fields: ['id', 'completed'] },
  ...over,
});

const REGISTRY = [
  { id: 'trigger.manual', label: '手動觸發', risk: 'read_only' },
  { id: 'source.http_get', label: '公開 HTTPS GET', risk: 'read_only' },
  { id: 'delivery.smtp_email_draft', label: 'Email 寄送', risk: 'external_write',
    credentialRequirements: ['SMTP credential'], configurationRequirements: ['recipient email'] },
];

// ---- fingerprint ----

test('鍵的順序不影響 fingerprint', () => {
  const a = { version: '1.0', goal: 'g', steps: [], expectedOutput: {} };
  const b = { expectedOutput: {}, steps: [], goal: 'g', version: '1.0' };
  assert.equal(computeFingerprint(a, CTX), computeFingerprint(b, CTX));
});

test('把 planFingerprint 寫回 IR 不會改變 IR 自身的 fingerprint', () => {
  const base = ir();
  const fp = computeFingerprint(base, CTX);
  assert.equal(computeFingerprint({ ...base, planFingerprint: fp }, CTX), fp,
    '否則寫回欄位就會讓 approval 立刻失效');
});

test('IR 內容改變 → fingerprint 改變', () => {
  assert.notEqual(computeFingerprint(ir(), CTX), computeFingerprint(ir({ goal: '別的目標' }), CTX));
});

test('runtime schema 改變 → fingerprint 改變（核心命題）', () => {
  assert.notEqual(computeFingerprint(ir(), CTX),
    computeFingerprint(ir(), { ...CTX, runtimeSchemaRevision: '2.19.0+xyz' }));
});

test('skill registry 改變 → fingerprint 改變', () => {
  assert.notEqual(computeFingerprint(ir(), CTX),
    computeFingerprint(ir(), { ...CTX, skillRegistryRevision: 'reg-2' }));
});

test('缺少 revision 一律拒絕，不得以預設值放行', () => {
  assert.throws(() => computeFingerprint(ir(), {}), /runtimeSchemaRevision is required/);
  assert.throws(() => computeFingerprint(ir(), { runtimeSchemaRevision: 'x' }), /skillRegistryRevision/);
});

// ---- 核心保證：規格 §10 第 1、2 題 ----

test('§10-1：沒有 token 就不能編譯', () => {
  assert.throws(() => assertApprovedForCompilation(null, ir(), CTX, OPTS), /拒絕編譯.*token 缺失/);
});

test('§10-2：核准 plan A、送出 IR B —— 必須失敗', () => {
  const token = issueApprovalToken(ir(), CTX, OPTS);
  const tampered = ir({ goal: '偷偷改成別的目標' });
  const r = verifyApprovalToken(token, tampered, CTX, OPTS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /不屬於當前的計畫/);
  assert.notEqual(r.approvedFingerprint, r.currentFingerprint);
  assert.throws(() => assertApprovedForCompilation(token, tampered, CTX, OPTS), /拒絕編譯/);
});

test('對同一份 IR 的 token 有效', () => {
  const token = issueApprovalToken(ir(), CTX, OPTS);
  assert.equal(verifyApprovalToken(token, ir(), CTX, OPTS).valid, true);
  assert.doesNotThrow(() => assertApprovedForCompilation(token, ir(), CTX, OPTS));
});

test('步驟被偷改（連 URL 換掉）也會失效', () => {
  const token = issueApprovalToken(ir(), CTX, OPTS);
  const evil = ir();
  evil.steps[1].urlRef = 'https://169.254.169.254/latest/meta-data/';
  assert.equal(verifyApprovalToken(token, evil, CTX, OPTS).valid, false);
});

test('核准後 n8n 升級 → 舊 token 失效', () => {
  const token = issueApprovalToken(ir(), CTX, OPTS);
  const r = verifyApprovalToken(token, ir(), { ...CTX, runtimeSchemaRevision: '2.19.0+new' }, OPTS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /runtime/);
});

test('token 無法偽造：不知道 secret 就簽不出來', () => {
  const forged = { v: 1, fingerprint: computeFingerprint(ir(), CTX), sessionId: 'sess-1',
    expiresAt: Date.now() + 60000, signature: 'a'.repeat(64) };
  const r = verifyApprovalToken(forged, ir(), CTX, OPTS);
  assert.equal(r.valid, false);
  assert.match(r.reason, /簽章無效/);
});

test('別的 secret 簽出來的 token 無效', () => {
  const token = issueApprovalToken(ir(), CTX, { ...OPTS, secret: 'another-approval-secret-32-chars' });
  assert.equal(verifyApprovalToken(token, ir(), CTX, OPTS).valid, false);
});

test('別的 session 的 token 無效', () => {
  const token = issueApprovalToken(ir(), CTX, OPTS);
  assert.equal(verifyApprovalToken(token, ir(), CTX, { ...OPTS, sessionId: 'sess-2' }).valid, false);
});

test('token 會過期', () => {
  const now = Date.now();
  const token = issueApprovalToken(ir(), CTX, { ...OPTS, now, ttlSeconds: 60 });
  assert.equal(verifyApprovalToken(token, ir(), CTX, { ...OPTS, now: now + 59000 }).valid, true);
  const late = verifyApprovalToken(token, ir(), CTX, { ...OPTS, now: now + 61000 });
  assert.equal(late.valid, false);
  assert.match(late.reason, /過期/);
});

test('竄改 token 內的 expiresAt 會破壞簽章', () => {
  const token = issueApprovalToken(ir(), CTX, { ...OPTS, ttlSeconds: 1 });
  const extended = { ...token, expiresAt: Date.now() + 999999999 };
  assert.match(verifyApprovalToken(extended, ir(), CTX, OPTS).reason, /簽章無效/);
});

// ---- renderPlan ----

test('renderPlan 是純函式：同一份 IR 必然得到同一份 plan', () => {
  assert.deepEqual(renderPlan(ir(), { skillRegistry: REGISTRY }), renderPlan(ir(), { skillRegistry: REGISTRY }));
});

test('renderPlan 顯示會連到哪些網域（審查建議 B8）', () => {
  const plan = renderPlan(ir(), { skillRegistry: REGISTRY });
  assert.deepEqual(plan.externalDomains, ['jsonplaceholder.typicode.com'],
    '使用者看到 169.254.169.254 會知道不對勁，看到「步驟 2：讀取資料」不會');
});

test('renderPlan 標示外部寫入與所需設定', () => {
  const withEmail = ir({ steps: [
    { id: 'a', kind: 'source.http_get', urlRef: 'https://example.com/x', outputShape: 'ItemList<T>' },
    { id: 'b', kind: 'delivery.smtp_email_draft', outputShape: 'NoOutput' },
  ] });
  const plan = renderPlan(withEmail, { skillRegistry: REGISTRY });
  assert.deepEqual(plan.sideEffects, ['Email 寄送']);
  assert.deepEqual(plan.setupRequirements, ['SMTP credential', 'recipient email']);
});

test('renderPlan 不含 raw JSON 或 node type（§5.1：使用者看到的是 plan，不是 JSON）', () => {
  const text = JSON.stringify(renderPlan(ir(), { skillRegistry: REGISTRY }));
  assert.doesNotMatch(text, /n8n-nodes-base|typeVersion|jsCode/);
});

test('plan 與 IR 綁在一起：改 IR 則 plan 與 fingerprint 同步改變', () => {
  const a = ir(); const b = ir({ goal: '不同目標' });
  assert.notEqual(renderPlan(a).goal, renderPlan(b).goal);
  assert.notEqual(computeFingerprint(a, CTX), computeFingerprint(b, CTX));
});

test('canonicalizeIr 與 stableStringify 對相同內容穩定', () => {
  assert.equal(canonicalizeIr(ir()), canonicalizeIr(ir()));
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test('secret 邊界：31 字元必須被拒絕，32 字元可通過（C0-3 政策 >= 32）', () => {
  const short = 'a'.repeat(31);
  const ok = 'a'.repeat(32);
  assert.throws(() => issueApprovalToken(ir(), CTX, { ...OPTS, secret: short }), /at least 32/);
  assert.doesNotThrow(() => issueApprovalToken(ir(), CTX, { ...OPTS, secret: ok }));
});

test('verifyApprovalToken 也自我強制 secret 長度，不依賴呼叫端 gate', () => {
  const token = issueApprovalToken(ir(), CTX, OPTS);
  assert.throws(
    () => verifyApprovalToken(token, ir(), CTX, { secret: 'a'.repeat(31), sessionId: 'sess-1' }),
    /at least 32/,
  );
});

// --- 來源 schema 版本綁定（選填，分階段接線用）---

test('不提供 sourceRegistryRevision 時，指紋與原本相同（不打破既有呼叫點）', () => {
  const a = computeFingerprint(ir(), CTX);
  const b = computeFingerprint(ir(), { ...CTX, sourceRegistryRevision: undefined });
  assert.equal(a, b);
});

test('提供 sourceRegistryRevision 會改變指紋，且不同值產生不同指紋', () => {
  const base = computeFingerprint(ir(), CTX);
  const withSrc = computeFingerprint(ir(), { ...CTX, sourceRegistryRevision: 'abc123' });
  const other = computeFingerprint(ir(), { ...CTX, sourceRegistryRevision: 'def456' });
  assert.notEqual(withSrc, base, '來源宣告改變時既有核准必須失效');
  assert.notEqual(withSrc, other);
});

test('sourceRegistryRevision 提供空字串視為設定錯誤', () => {
  assert.throws(() => computeFingerprint(ir(), { ...CTX, sourceRegistryRevision: '' }),
    /不得為空字串/);
});
