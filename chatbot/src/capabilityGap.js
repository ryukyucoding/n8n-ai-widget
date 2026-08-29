'use strict';

// R5：capability_gap 的三段式回覆。
//
// 問題（審查 B2）：目前 capability_gap 只提供「說明缺少哪個 skill」+「儲存需求／換模式／降級草稿」。
// 從使用者視角這是：「系統告訴你它不行，然後結束對話。」
// 以規格自己的案例 C（影片生成 + 每 30 秒輪詢 + Drive 上傳 + 失敗通知）為例，
// 系統會列出七八個 gap —— **沒有任何使用者會讀完那個清單。**
//
// 關鍵洞察：**缺少某個 skill 不代表使用者的目標達不到，只代表最直覺的做法達不到。**
// 缺 Wait node 不等於「無法定期檢查狀態」，只等於「無法用輪詢實作它」。
// 因此本模組的核心是一張**降級對照表**：把「做不到的做法」映射到「做得到的近似做法」。
//
// 三段式回覆（規格 §5 應明訂為必填）：
//   1. 最接近的可行替代方案 —— 實務上能救回大部分需求
//   2. 部分交付 —— 哪幾段現在就能做，哪幾段留給手動
//   3. 需求登記 —— 該 skill 上線時通知；同時是最真實的需求分佈資料

const assert = (c, m) => { if (!c) throw new Error(m); };

// 降級對照表。每一條都要寫清楚**取捨**——不能只說「可以這樣代替」而不講代價，
// 那會讓使用者在不知情的狀況下接受一個不同的東西。
const DEGRADATIONS = Object.freeze([
  {
    missing: 'control.wait',
    triggers: ['輪詢', 'polling', '每隔', '等待', 'wait', 'poll'],
    alternative: '改用排程定期檢查狀態，而不是在同一次執行中等待',
    requires: ['workflow.daily_rss_digest'],
    tradeoff: '延遲從「秒級」變成「排程間隔」；每次檢查是獨立執行，需要外部記錄任務狀態',
  },
  {
    missing: 'control.flow',
    triggers: ['如果', '條件', '分支', 'if', 'branch', '失敗時'],
    alternative: '拆成兩個各自單純的 workflow，由使用者決定執行哪一個',
    requires: [],
    tradeoff: '失去自動分支；使用者必須自己判斷情況',
  },
  {
    missing: 'http.authenticated_request',
    triggers: ['api key', 'token', '認證', '登入', 'oauth', '授權'],
    alternative: '若該服務有公開端點，改用公開資料；否則建立 inactive draft 並由使用者在 n8n 補上認證',
    requires: ['http.public_get'],
    tradeoff: '公開端點的資料範圍通常較窄；走 draft 則需要使用者自行完成設定',
  },
  {
    missing: 'binary.download',
    triggers: ['下載', '檔案', '圖片', '影片', 'binary', 'upload'],
    alternative: '輸出檔案網址而不是檔案本身，由使用者或下游自行取用',
    requires: ['output.one_object'],
    tradeoff: '不經手檔案內容，因此無法轉檔、壓縮或檢查內容',
  },
  {
    missing: 'delivery.notification',
    triggers: ['通知', '提醒', 'notify', 'alert'],
    alternative: '把結果寫進輸出，由使用者在 n8n 自行接上通知節點',
    requires: ['output.one_object'],
    tradeoff: '不會主動推播；使用者要自己查看或自行接線',
  },
]);

function normalize(text) {
  return String(text || '').toLowerCase();
}

/** 從使用者原文與缺失 skill 兩個方向找降級方案，兩者取聯集。 */
function findAlternatives(missingSkillIds, userRequest, availableSkillIds) {
  const available = new Set(availableSkillIds);
  const request = normalize(userRequest);
  const seen = new Set();
  const out = [];

  for (const entry of DEGRADATIONS) {
    const byMissing = missingSkillIds.includes(entry.missing);
    const byText = entry.triggers.some((t) => request.includes(normalize(t)));
    if (!byMissing && !byText) continue;
    if (seen.has(entry.missing)) continue;
    seen.add(entry.missing);

    // 只在替代方案所需的 skill 都已實作時才提出——否則等於再開一張空頭支票
    const usable = entry.requires.every((id) => available.has(id));
    out.push({
      insteadOf: entry.missing,
      suggestion: entry.alternative,
      tradeoff: entry.tradeoff,
      usableNow: usable,
      requires: entry.requires,
    });
  }
  return out;
}

/**
 * 產生 capability_gap 的完整回覆。
 *
 * @param {{userRequest:string, requestedSkillIds:string[], registry:Array}} input
 */
function buildCapabilityGapResponse({ userRequest, requestedSkillIds, registry }) {
  assert(Array.isArray(requestedSkillIds), 'requestedSkillIds must be an array');
  assert(Array.isArray(registry), 'registry must be an array');

  const byId = new Map(registry.map((s) => [s.id, s]));
  const implemented = registry.filter((s) => s.maturity !== 'planned').map((s) => s.id);

  const gaps = [];
  const canDoNow = [];
  for (const id of requestedSkillIds) {
    const skill = byId.get(id);
    if (!skill) {
      gaps.push({ capability: id, reason: '這個能力不在系統的支援清單中' });
    } else if (skill.maturity === 'planned') {
      gaps.push({ capability: id, label: skill.label, reason: '已規劃但尚未實作' });
    } else {
      canDoNow.push({ capability: id, label: skill.label });
    }
  }

  const missingIds = gaps.map((g) => g.capability);
  const alternatives = findAlternatives(missingIds, userRequest, implemented);

  // 部分交付：把能做的與不能做的分開，而不是整包拒絕
  const partial = {
    available: canDoNow.length > 0,
    canDoNow,
    needsManual: gaps.map((g) => ({
      capability: g.capability,
      label: g.label || g.capability,
      // 降級草稿的 placeholder 必須是會主動失敗的節點，不能是空的 NoOp——
      // 否則使用者手動啟用後會「跑成功但什麼都沒做」，那比報錯更糟（審查 C2）
      placeholderBehaviour: 'stop_and_error',
    })),
  };

  const backlog = gaps.length === 0 ? null : {
    kind: 'capability_request',
    requestedAt: null,          // 由呼叫端填入，保持本函式為純函式
    userRequest: String(userRequest || ''),
    missingCapabilities: missingIds,
    notifyWhenAvailable: true,
  };

  return {
    state: gaps.length === 0 ? 'supported' : 'capability_gap',
    gaps,
    alternatives,
    partial,
    backlog,
    // 給 UI 的三段式提示。刻意不含 skill id 或節點名稱——使用者不需要知道那些
    presentation: gaps.length === 0 ? null : {
      whatIsMissing: gaps.map((g) => g.label || g.capability),
      nearestAlternative: alternatives.filter((a) => a.usableNow).map((a) => ({
        suggestion: a.suggestion, tradeoff: a.tradeoff,
      })),
      partialOffer: canDoNow.length > 0
        ? `其中 ${canDoNow.length} 個步驟現在就能建立，其餘需要你在 n8n 手動接續`
        : null,
      canRegisterRequest: true,
    },
  };
}

module.exports = { DEGRADATIONS, findAlternatives, buildCapabilityGapResponse };
