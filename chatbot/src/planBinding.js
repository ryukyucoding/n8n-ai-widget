'use strict';

// R1：核准與編譯之間的綁定層。
//
// 問題（規格審查 A1）：planReviewGate 對「人類可讀 plan」取 hash，但 compiler 消費的是 IR，
// 而 IR schema 沒有 planFingerprint 欄位。因此「核准 plan A、送出 IR B」在型別層面完全合法，
// 使規格 §10 第 1、2 題的保證只是承諾而非機制。
//
// 三個設計決定：
//   1. IR 是唯一事實，plan 是 IR 的 deterministic rendering。規格原本寫「planner 產生 plan 與 IR」
//      （平行），那讓 planner 可能產出「說得好聽的 plan」配「做別的事的 IR」。
//      改為 renderPlan(ir) 後，兩者不一致在結構上不可能發生，而非靠 planner 自律。
//   2. fingerprint 綁 IR + runtimeSchemaRevision + skillRegistryRevision。核准與編譯之間
//      若 n8n 升級或 registry 改變，approval 自動失效——這正是規格的核心命題，原本卻沒被涵蓋。
//   3. approval 是 HMAC 簽章的 token，不是布林值。原本 canCompileApprovedPlan() 是純函式，
//      呼叫端可以忘記呼叫（實測：無任何 caller）。改成必須出示 token 才能編譯。
//
// 刻意不修改 pipelineIr.js 與 planReviewGate.js（Codex 的範圍，他表示 R1/R2 應併入
// 他的 planner 接線設計）。這裡只提供可被接上的機制。

const crypto = require('node:crypto');

const DEFAULT_TTL_SECONDS = 24 * 3600;
const BINDING_FIELDS = ['planFingerprint', 'approvalRevision'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 穩定序列化：key 排序後再 hash，讓 fingerprint 只反映內容、不反映鍵的插入順序。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// 移除綁定欄位後序列化——否則把 fingerprint 寫回 IR 會改變 IR 自身的 fingerprint。
function canonicalizeIr(ir) {
  assert(ir && typeof ir === 'object' && !Array.isArray(ir), 'ir must be an object');
  const rest = { ...ir };
  for (const field of BINDING_FIELDS) delete rest[field];
  return stableStringify(rest);
}

function computeFingerprint(
  ir,
  { runtimeSchemaRevision, skillRegistryRevision, sourceRegistryRevision } = {},
) {
  assert(typeof runtimeSchemaRevision === 'string' && runtimeSchemaRevision,
    'runtimeSchemaRevision is required — approval must be invalidated when the runtime changes');
  assert(typeof skillRegistryRevision === 'string' && skillRegistryRevision,
    'skillRegistryRevision is required');
  // sourceRegistryRevision 為選填，讓來源 schema 綁定可以分階段接線而不打破既有呼叫點。
  // 一旦提供就併入指紋：外部 API 的欄位宣告改變時，既有核准必須失效——
  // 理由與 runtime schema 改變時相同，使用者當初核准的是「依那份宣告產生的計畫」。
  if (sourceRegistryRevision !== undefined) {
    assert(typeof sourceRegistryRevision === 'string' && sourceRegistryRevision,
      'sourceRegistryRevision 若提供則不得為空字串');
  }
  const parts = [canonicalizeIr(ir), runtimeSchemaRevision, skillRegistryRevision];
  if (sourceRegistryRevision !== undefined) parts.push(`src:${sourceRegistryRevision}`);
  return crypto.createHash('sha256').update(parts.join(' ')).digest('hex');
}

const SHAPE_LABEL = { SingleItem: '單一物件', ItemList: '多筆項目', Binary: '二進位資料', NoOutput: '無輸出' };

function shapeLabel(shape) {
  if (typeof shape !== 'string') return '未知';
  const kind = shape === 'NoOutput' ? 'NoOutput' : shape.slice(0, shape.indexOf('<'));
  return SHAPE_LABEL[kind] || shape;
}

function hostOf(reference) {
  try { return new URL(String(reference)).hostname; } catch { return null; }
}

// 從 IR 產生人類可讀 plan。純函式，同一份 IR 必然得到同一份 plan。
// 刻意包含審查建議 B8 指出、原範例缺少的三項：會連到哪些網域、哪些步驟有外部寫入、執行頻率。
function renderPlan(ir, { skillRegistry = null } = {}) {
  assert(ir && Array.isArray(ir.steps), 'ir.steps is required');
  const externalDomains = [];
  const sideEffects = [];
  const setupRequirements = [];
  const steps = [];

  for (const step of ir.steps) {
    const skill = skillRegistry ? skillRegistry.find((s) => s.id === step.kind) : null;
    const label = (skill && skill.label) || step.kind;
    steps.push(`${label}（輸出：${shapeLabel(step.outputShape)}）`);
    for (const key of ['urlRef', 'url', 'feedUrl', 'reference']) {
      const host = hostOf(step[key]);
      if (host && !externalDomains.includes(host)) externalDomains.push(host);
    }
    if (skill && skill.risk === 'external_write') sideEffects.push(label);
    for (const r of (skill && skill.credentialRequirements) || []) {
      if (!setupRequirements.includes(r)) setupRequirements.push(r);
    }
    for (const r of (skill && skill.configurationRequirements) || []) {
      if (!setupRequirements.includes(r)) setupRequirements.push(r);
    }
  }

  return {
    goal: String(ir.goal || '').trim(),
    steps,
    expectedOutput: {
      shape: shapeLabel(ir.expectedOutput && ir.expectedOutput.shape),
      fields: (ir.expectedOutput && ir.expectedOutput.fields) || [],
    },
    externalDomains,
    sideEffects,
    setupRequirements,
    schedule: ir.schedule || null,
  };
}

// C0-3：政策要求 >= 32。issue 與 verify 都檢查，讓模組自我強制，
// 而不是依賴呼叫端（index.js）的 gate 是唯一防線。
const MIN_SECRET_LENGTH = 32;

function assertSecret(secret) {
  assert(
    typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH,
    `secret must be at least ${MIN_SECRET_LENGTH} characters`,
  );
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// 由 review gate 在使用者核准當下簽發。secret 不得進入 planner context 或日誌。
function issueApprovalToken(ir, context, { secret, sessionId, now = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS }) {
  assertSecret(secret);
  assert(typeof sessionId === 'string' && sessionId, 'sessionId is required');
  const fingerprint = computeFingerprint(ir, context);
  const body = { v: 1, fingerprint, sessionId, expiresAt: now + ttlSeconds * 1000 };
  return { ...body, signature: sign(stableStringify(body), secret) };
}

// compiler 的唯一入口條件。回傳 reason 而非只是 false——使用者要知道為什麼要重新核准。
function verifyApprovalToken(token, ir, context, { secret, sessionId, now = Date.now() }) {
  assertSecret(secret);
  if (!token || typeof token !== 'object') return { valid: false, reason: 'approval token 缺失' };
  const { signature, ...body } = token;
  if (typeof signature !== 'string') return { valid: false, reason: 'approval token 沒有簽章' };

  const expected = sign(stableStringify(body), secret);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'approval token 簽章無效——它不是由本系統簽發的' };
  }
  if (body.sessionId !== sessionId) return { valid: false, reason: 'approval token 屬於另一個 session' };
  if (typeof body.expiresAt !== 'number' || body.expiresAt <= now) {
    return { valid: false, reason: 'approval token 已過期，請重新檢視計畫' };
  }
  const current = computeFingerprint(ir, context);
  if (body.fingerprint !== current) {
    return {
      valid: false,
      reason: '這份核准不屬於當前的計畫或執行環境。可能是計畫在核准後被修改，'
        + '或 n8n runtime／skill registry 已變更。依規格 §10 第 1、2 題，必須重新規劃並取得使用者核准。',
      approvedFingerprint: body.fingerprint,
      currentFingerprint: current,
    };
  }
  return { valid: true, reason: null, fingerprint: current };
}

// compiler 的守門函式。設計成「忘記傳 token 就編譯不了」，而不是回傳布林讓呼叫端自行判斷——
// 這是審查 A2 的核心：只被描述的規矩會被忘記，能被強制的才會被遵守。
function assertApprovedForCompilation(token, ir, context, options) {
  const result = verifyApprovalToken(token, ir, context, options);
  if (!result.valid) throw new Error(`拒絕編譯：${result.reason}`);
  return result;
}

module.exports = {
  MIN_SECRET_LENGTH,
  DEFAULT_TTL_SECONDS, stableStringify, canonicalizeIr, computeFingerprint,
  renderPlan, issueApprovalToken, verifyApprovalToken, assertApprovedForCompilation,
};
