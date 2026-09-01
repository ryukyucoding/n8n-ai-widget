'use strict';

// R11：Plan Diff 的風險分級。
//
// 問題（審查 B3）：規格 §5.1 允許「只改不改變風險的常數」走快速核准。
// 但誰判定「不改變風險」？**若由 planner（LLM）宣告，幻覺或惡意輸入只要把變更標成 low-risk
// 就能繞過完整重審。** 而「常數」可以是：
//     recipient: team@company.com → attacker@evil.com   （只是一個字串）
//     limit: 10 → 100000                                 （只是一個數字）
//     Drive folder ID 換一個                              （只是一個 ID）
//
// 因此本模組的核心規則：**風險分級是對兩份 IR 做結構比對的結果，永遠不讀 IR 裡的任何
// riskLevel / severity 宣告欄位。** planner 說什麼都不影響分級。
//
// 另一項規則（審查 §5.1）：呈現給使用者的是 Semantic Delta，不是 JSON diff。
// 技術 diff 只提供給進階除錯畫面。

const HIGH = 'high';
const LOW = 'low';

// 這些欄位若出現在 IR 中會被**忽略**——它們是 planner 可能用來自我宣告風險的欄位。
const IGNORED_SELF_DECLARED = new Set([
  'riskLevel', 'risk', 'severity', 'requiresReview', 'isLowRisk', 'safe', 'trivial',
]);

// 目的地類欄位：任何變更一律 high。使用者唯一真正在意的是「東西送到哪裡去」。
const SINK_KEYS = [
  'recipient', 'recipientEmail', 'to', 'sender', 'senderEmail', 'from',
  'folderId', 'driveFolderId', 'channel', 'channelId', 'chatId', 'webhookUrl',
  'bucket', 'path', 'destination', 'databaseId', 'sheetId', 'spreadsheetId',
];
// 連線類欄位：比對 host，換 host 一律 high。
const URL_KEYS = ['url', 'urlRef', 'feedUrl', 'endpoint', 'reference'];
// 數量／頻率類欄位：數量級變化（>10 倍）一律 high。
const MAGNITUDE_KEYS = ['limit', 'maxItems', 'lookbackHours', 'intervalSeconds', 'batchSize', 'retries', 'timeoutMs'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hostOf(value) {
  try { return new URL(String(value)).hostname.toLowerCase(); } catch { return null; }
}

function stepsById(ir) {
  const map = new Map();
  for (const step of (ir.steps || [])) map.set(step.id, step);
  return map;
}

/** 剔除 planner 自我宣告的風險欄位，確保它們永遠不影響比對。 */
function stripSelfDeclared(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripSelfDeclared);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (IGNORED_SELF_DECLARED.has(k)) continue;
    out[k] = stripSelfDeclared(v);
  }
  return out;
}

function compareStep(before, after, findings) {
  const id = after.id;
  const a = stripSelfDeclared(before);
  const b = stripSelfDeclared(after);

  if (a.kind !== b.kind) {
    findings.push({ level: HIGH, step: id, kind: 'step_kind_changed',
      text: `步驟「${id}」的動作從 ${a.kind} 改為 ${b.kind}` });
  }
  if (JSON.stringify(a.dependsOn || []) !== JSON.stringify(b.dependsOn || [])) {
    findings.push({ level: HIGH, step: id, kind: 'topology_changed',
      text: `步驟「${id}」的上游連接改變了` });
  }
  if (a.outputShape !== b.outputShape || a.inputShape !== b.inputShape) {
    findings.push({ level: HIGH, step: id, kind: 'shape_changed',
      text: `步驟「${id}」的資料形狀改變了` });
  }

  for (const key of SINK_KEYS) {
    if (key in a || key in b) {
      if (a[key] !== b[key]) {
        findings.push({ level: HIGH, step: id, kind: 'destination_changed',
          text: `步驟「${id}」的目的地（${key}）從「${a[key] ?? '未設定'}」改為「${b[key] ?? '未設定'}」` });
      }
    }
  }

  for (const key of URL_KEYS) {
    if (!(key in a) && !(key in b)) continue;
    const hostA = hostOf(a[key]);
    const hostB = hostOf(b[key]);
    if (hostA !== hostB) {
      findings.push({ level: HIGH, step: id, kind: 'host_changed',
        text: `步驟「${id}」連線的網域從「${hostA ?? '未設定'}」改為「${hostB ?? '未設定'}」` });
    } else if (a[key] !== b[key]) {
      findings.push({ level: LOW, step: id, kind: 'url_path_changed',
        text: `步驟「${id}」在同一網域（${hostB}）內的路徑或參數改變了` });
    }
  }

  for (const key of MAGNITUDE_KEYS) {
    if (!(key in a) && !(key in b)) continue;
    const x = Number(a[key]);
    const y = Number(b[key]);
    if (x === y) continue;
    const bigJump = !Number.isFinite(x) || !Number.isFinite(y) || x === 0
      || y / x > 10 || x / y > 10;
    findings.push({ level: bigJump ? HIGH : LOW, step: id,
      kind: bigJump ? 'magnitude_changed' : 'value_changed',
      text: `步驟「${id}」的 ${key} 從 ${a[key]} 改為 ${b[key]}`
        + (bigJump ? '（數量級變化超過 10 倍）' : '') });
  }

  // 其餘欄位：值變了就記錄為 low，但上面任何一條命中都會蓋過它
  const seen = new Set([...SINK_KEYS, ...URL_KEYS, ...MAGNITUDE_KEYS,
    'id', 'kind', 'dependsOn', 'inputShape', 'outputShape']);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (seen.has(key)) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      findings.push({ level: LOW, step: id, kind: 'value_changed',
        text: `步驟「${id}」的 ${key} 改變了` });
    }
  }
}

/**
 * 比較兩份 IR，回傳 Semantic Delta 與**結構性計算出的**風險等級。
 *
 * @returns {{level, requiresFullReview, findings, summary, unchanged}}
 */
function diffPlans(beforeIr, afterIr, { skillRegistry = null } = {}) {
  assert(beforeIr && typeof beforeIr === 'object', 'beforeIr is required');
  assert(afterIr && typeof afterIr === 'object', 'afterIr is required');

  const findings = [];
  const before = stepsById(beforeIr);
  const after = stepsById(afterIr);

  for (const [id, step] of after) {
    if (!before.has(id)) {
      const skill = skillRegistry ? skillRegistry.find((s) => s.id === step.kind) : null;
      findings.push({ level: HIGH, step: id, kind: 'step_added',
        text: `新增步驟「${id}」：${(skill && skill.label) || step.kind}`
          + (skill && skill.risk === 'external_write' ? '（會寫入外部系統）' : '') });
    } else {
      compareStep(before.get(id), step, findings);
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      findings.push({ level: HIGH, step: id, kind: 'step_removed', text: `移除步驟「${id}」` });
    }
  }

  if (String(beforeIr.goal || '') !== String(afterIr.goal || '')) {
    findings.push({ level: LOW, step: null, kind: 'goal_changed', text: '目標敘述改變了' });
  }
  const beforeOut = JSON.stringify(stripSelfDeclared(beforeIr.expectedOutput || {}));
  const afterOut = JSON.stringify(stripSelfDeclared(afterIr.expectedOutput || {}));
  if (beforeOut !== afterOut) {
    findings.push({ level: HIGH, step: null, kind: 'expected_output_changed', text: '預期輸出改變了' });
  }

  const level = findings.some((f) => f.level === HIGH) ? HIGH : LOW;
  const highs = findings.filter((f) => f.level === HIGH);

  return {
    level,
    // 即使是 low，仍需使用者明確核准新版本（fingerprint 永不重用）；
    // 差異式審核只降低閱讀摩擦，不降低一致性要求。
    requiresFullReview: level === HIGH,
    requiresExplicitApproval: true,
    findings,
    summary: findings.length === 0 ? '沒有實質變更。'
      : (level === HIGH
        ? `有 ${highs.length} 項需要完整重審的變更：${highs.map((f) => f.text).join('；')}`
        : `僅有不改變風險的調整：${findings.map((f) => f.text).join('；')}`),
    unchanged: {
      externalWriteCount: (afterIr.steps || []).filter((s) => {
        const skill = skillRegistry ? skillRegistry.find((x) => x.id === s.kind) : null;
        return skill && skill.risk === 'external_write';
      }).length,
    },
  };
}

module.exports = { HIGH, LOW, SINK_KEYS, URL_KEYS, MAGNITUDE_KEYS, IGNORED_SELF_DECLARED, diffPlans };
