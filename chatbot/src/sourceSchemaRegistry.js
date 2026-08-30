'use strict';

// 來源 schema 綁定（能力擴充第 1 步）
//
// 為什麼需要這個模組：
// compiler 目前只檢查欄位名稱是否為安全識別字，不檢查該欄位是否真的存在於外部 API 的回應中。
// 實測（2026-08-30）：把主機換掉、欄位寫成不存在的名字，編譯照樣通過，產生的 code 節點是
//   records.filter((r) => r.totally_nonexistent_boolean_field === false)
//   source.this_field_does_not_exist
// 那個 workflow 會「執行成功」並回傳 undefined 與 0。
// 那正是本專案要消滅的失敗模式——看起來合理、跑得動、但是錯的——
// 只是從「n8n 的節點 schema」搬到了「外部 API 的回應 schema」。
//
// 設計原則與 runtimeSchemaRevision 相同：宣告 schema → 驗證引用 → 版本可綁進 approval token。
// 一律 fail closed：來源未登錄就拒絕，欄位未宣告就拒絕，比對到多個來源也拒絕。
//
// 型別為什麼要驗：count_false_boolean 會產生 `record.<field> === false`。
// 若該欄位不是布林，這個比較永遠為 false，結果安靜地變成 0——不會報錯，只會給出錯的答案。
// 因此「欄位存在」不足以擋住錯誤輸出，必須連型別一起驗。

const crypto = require('node:crypto');

const FIELD_TYPES = new Set(['string', 'number', 'boolean']);

// 每個來源都必須有 verifiedAt：代表有人實際打過那個端點並核對過欄位，
// 而不是照著文件抄的。沒有這個欄位就不該進這份清單。
const SOURCES = Object.freeze([
  Object.freeze({
    id: 'jsonplaceholder.user',
    host: 'jsonplaceholder.typicode.com',
    path: '/users/:id',
    cardinality: 'one_object',
    verifiedAt: '2026-08-30',
    fields: Object.freeze({
      id: 'number', name: 'string', username: 'string', email: 'string',
      phone: 'string', website: 'string',
    }),
  }),
  Object.freeze({
    id: 'jsonplaceholder.todos',
    host: 'jsonplaceholder.typicode.com',
    path: '/todos',
    cardinality: 'items',
    verifiedAt: '2026-08-30',
    fields: Object.freeze({
      id: 'number', userId: 'number', title: 'string', completed: 'boolean',
    }),
  }),
  Object.freeze({
    id: 'jsonplaceholder.user.todos',
    host: 'jsonplaceholder.typicode.com',
    path: '/users/:id/todos',
    cardinality: 'items',
    verifiedAt: '2026-08-30',
    fields: Object.freeze({
      id: 'number', userId: 'number', title: 'string', completed: 'boolean',
    }),
  }),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch (_) { return null; }
  if (url.protocol !== 'https:') return null;
  return url;
}

// 路徑比對：只支援 :param 形式的單一區段萬用，不接受設定檔提供正規表達式
// （避免 ReDoS，也讓清單保持可讀）。
function pathMatches(pattern, actualPath) {
  const want = pattern.split('/').filter(Boolean);
  const got = actualPath.split('/').filter(Boolean);
  if (want.length !== got.length) return false;
  return want.every((segment, index) => (
    segment.startsWith(':') ? got[index].length > 0 : segment === got[index]
  ));
}

/**
 * 依 URL 找出已登錄的來源。找不到回傳 null；比對到多個則丟出例外（不猜）。
 */
function resolveSource(rawUrl, registry = SOURCES) {
  const url = parseUrl(rawUrl);
  if (!url) return null;
  const matches = registry.filter((source) => (
    source.host === url.hostname && pathMatches(source.path, url.pathname)
  ));
  assert(matches.length <= 1,
    `來源比對到多個登錄項目，無法判定：${matches.map((m) => m.id).join(', ')}`);
  return matches[0] || null;
}

/**
 * URL 必須對應到一個已登錄來源，否則拒絕。
 * 這是 allowlist 之外的第二道關卡：allowlist 管「這個主機安不安全」，
 * 本函式管「我們知不知道它會回傳什麼」。兩者都要通過。
 */
function assertSourceRegistered(rawUrl, field = 'url', registry = SOURCES) {
  const source = resolveSource(rawUrl, registry);
  assert(source, `${field}：${rawUrl} 沒有登錄的回應 schema。`
    + `新增公開 API 必須同時登錄其回應欄位，否則 compiler 無法確認 planner 引用的欄位存在。`);
  return source;
}

/**
 * 驗證某個欄位確實存在於來源的宣告 schema 中，並可選擇性驗證型別。
 * expectedType 用於「該轉換對型別有要求」的情形，例如 count_false_boolean 需要 boolean。
 */
function assertField(source, fieldName, { expectedType = null, usedBy = '' } = {}) {
  assert(source && source.fields, 'source 必須是已登錄的來源');
  const actual = source.fields[fieldName];
  const where = usedBy ? `（${usedBy}）` : '';
  assert(actual, `${source.id} 沒有宣告欄位 ${fieldName}${where}。`
    + `已宣告的欄位：${Object.keys(source.fields).join(', ')}`);
  if (expectedType) {
    assert(FIELD_TYPES.has(expectedType), `expectedType 不支援：${expectedType}`);
    assert(actual === expectedType,
      `${source.id}.${fieldName} 的型別是 ${actual}，但${where || '此處'}需要 ${expectedType}。`
      + `型別不符不會在執行時報錯，只會安靜地產生錯誤結果，因此在編譯期擋下。`);
  }
  return actual;
}

/**
 * 來源基數必須與規格宣告的一致：
 * /users/:id 是單一物件，/todos 是列表。搞反了，下游轉換的假設就全錯。
 */
function assertCardinality(source, declared, field = 'cardinality') {
  assert(source.cardinality === declared,
    `${field}：${source.id} 回傳的是 ${source.cardinality}，規格卻宣告 ${declared}`);
  return declared;
}

/**
 * 給 planner prompt 用的來源說明。
 * 讓 prompt 從登錄清單生成，而不是手寫——新增來源時 planner 會自動知道，
 * 不必依賴有人記得同步修改 prompt。
 */
function describeForPlanner(registry = SOURCES) {
  return registry.map((source) => {
    const fields = Object.entries(source.fields)
      .map(([name, type]) => `${name}: ${type}`).join(', ');
    return `https://${source.host}${source.path} → ${source.cardinality} { ${fields} }`;
  }).join('\n');
}

/**
 * 版本摘要，可綁進 approval token——與 runtimeSchemaRevision 同一個模式。
 * 登錄清單一改，既有的核准就不再有效，使用者必須重新確認。
 */
function sourceRegistryRevision(registry = SOURCES) {
  const canonical = JSON.stringify(registry.map((source) => ({
    id: source.id, host: source.host, path: source.path,
    cardinality: source.cardinality, fields: source.fields,
  })));
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

module.exports = {
  SOURCES,
  FIELD_TYPES,
  resolveSource,
  assertSourceRegistered,
  assertField,
  assertCardinality,
  describeForPlanner,
  sourceRegistryRevision,
};
