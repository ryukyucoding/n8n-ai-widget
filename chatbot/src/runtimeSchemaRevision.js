'use strict';

// R17：整份規格的立論是「模型看到的 schema 與目前 runtime 不一致」，
// 但快照原本只有 generatedAt，沒有版本錨點——時間戳只能說明「多久沒抓」，
// 不能說明「runtime 是否真的變了」，反過來一次無實質變更的重抓也會產生新時間戳。
//
// 本模組提供 approval fingerprint 可以綁定的穩定值（R1 的前置依賴），
// 以及一個誠實的 freshness 判定：**不知道就說不知道，不要假設沒事**。
//
// 實測 2026-08-28：repo 內快照 generatedAt 為 2026-07-22、無 n8nVersion 欄位。

const crypto = require('node:crypto');

const DEFAULT_MAX_AGE_HOURS = 24 * 7;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 穩定序列化：key 排序後再 hash，讓 digest 只反映內容、不反映鍵的插入順序。
// 必須與 tools/export_runtime_node_schemas.js 的實作一致。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function computeDigest(nodeTypes) {
  return crypto.createHash('sha256').update(stableStringify(nodeTypes)).digest('hex');
}

/**
 * 從快照算出可綁定的 revision。
 * digest 優先於時間戳：內容沒變時 revision 不變，approval 不必因為「又抓了一次」而失效。
 */
function schemaRevision(snapshot) {
  assert(snapshot && typeof snapshot === 'object', 'snapshot is required');
  assert(snapshot.nodeTypes && typeof snapshot.nodeTypes === 'object', 'snapshot.nodeTypes is required');

  // 舊快照沒有 nodeTypesDigest，就地重算，讓 R1 不必等 export 工具重跑。
  const digest = typeof snapshot.nodeTypesDigest === 'string' && snapshot.nodeTypesDigest
    ? snapshot.nodeTypesDigest
    : computeDigest(snapshot.nodeTypes);

  return {
    revision: `${snapshot.n8nVersion || 'unknown'}+${digest.slice(0, 16)}`,
    n8nVersion: snapshot.n8nVersion || null,
    nodeTypesDigest: digest,
    nodeTypeCount: Object.keys(snapshot.nodeTypes).length,
    generatedAt: snapshot.generatedAt || null,
    digestWasRecomputed: !snapshot.nodeTypesDigest,
  };
}

/**
 * freshness 判定。回傳 status 是三值而非布林，因為「不知道」與「過期」必須分開：
 *   fresh    快照在容許時間內
 *   stale    確定超過容許時間
 *   unknown  無法判定（缺 generatedAt 或無法解析）——**不得當成 fresh**
 */
function assessFreshness(snapshot, { now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  const generatedAt = snapshot && snapshot.generatedAt;
  const findings = [];

  if (!snapshot || !snapshot.n8nVersion) {
    findings.push('快照沒有記錄 n8n 版本，無法確認它對應哪一個 runtime。'
      + '請在 n8n container 內重跑 tools/export_runtime_node_schemas.js。');
  }

  if (!generatedAt) {
    findings.push('快照沒有 generatedAt，無法判定新舊。');
    return { status: 'unknown', ageHours: null, findings };
  }

  const then = new Date(generatedAt);
  if (Number.isNaN(then.getTime())) {
    findings.push(`generatedAt 無法解析：${generatedAt}`);
    return { status: 'unknown', ageHours: null, findings };
  }

  const ageHours = (now.getTime() - then.getTime()) / 3600000;
  if (ageHours < 0) {
    findings.push('快照的 generatedAt 在未來，可能是時鐘不同步。');
    return { status: 'unknown', ageHours, findings };
  }
  if (ageHours > maxAgeHours) {
    findings.push(`快照已 ${Math.floor(ageHours / 24)} 天未更新（上限 ${Math.floor(maxAgeHours / 24)} 天）。`
      + '在此期間 n8n 若曾升級，所有「runtime-aware」的結論都只對舊 runtime 成立。');
    return { status: 'stale', ageHours, findings };
  }
  return { status: 'fresh', ageHours, findings };
}

/**
 * 判斷一份既有 approval 是否仍然有效。
 * 這是 R1 的接點：approval 綁定的是 revision，不是時間戳。
 */
function approvalStillValid(approvedRevision, currentSnapshot) {
  const current = schemaRevision(currentSnapshot);
  if (approvedRevision === current.revision) {
    return { valid: true, currentRevision: current.revision, reason: null };
  }
  return {
    valid: false,
    currentRevision: current.revision,
    reason: `runtime schema 已改變（核准時 ${approvedRevision}，現在 ${current.revision}）。`
      + '依規格 §10 第 2 題，舊核准不得用於編譯；必須重新規劃並取得使用者核准。',
  };
}

module.exports = {
  DEFAULT_MAX_AGE_HOURS,
  computeDigest,
  stableStringify,
  schemaRevision,
  assessFreshness,
  approvalStillValid,
};
