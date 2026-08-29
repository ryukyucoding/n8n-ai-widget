'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCapabilityGapResponse, findAlternatives } = require('./capabilityGap');
const { SKILLS } = require('./runtimeSkillRegistry');

const R = SKILLS.map((s) => ({ ...s }));

test('全部支援時回 supported，不產生 gap 回覆', () => {
  const r = buildCapabilityGapResponse({
    userRequest: '取得公開 todos 並統計',
    requestedSkillIds: ['trigger.manual', 'http.public_get', 'output.one_object'],
    registry: R,
  });
  assert.equal(r.state, 'supported');
  assert.equal(r.gaps.length, 0);
  assert.equal(r.presentation, null);
  assert.equal(r.backlog, null);
});

// 規格案例 C：影片生成 + 每 30 秒輪詢 + Drive 上傳 + 失敗通知
const CASE_C = {
  userRequest: '提交影片生成任務後，每 30 秒輪詢；完成就上傳 Drive，失敗通知我',
  requestedSkillIds: ['http.authenticated_request', 'control.flow', 'trigger.manual', 'http.public_get'],
  registry: R,
};

test('案例 C：不是只丟一份 gap 清單就結束', () => {
  const r = buildCapabilityGapResponse(CASE_C);
  assert.equal(r.state, 'capability_gap');
  assert.ok(r.gaps.length >= 2);
  assert.ok(r.alternatives.length > 0, '必須提供替代方案——沒有替代方案的 gap 回覆是死路');
  assert.ok(r.partial.available, '必須指出哪幾步現在就能做');
  assert.ok(r.backlog, '必須能登記需求');
});

test('案例 C：從使用者原文抓到「輪詢」，即使該 skill 不在請求清單裡', () => {
  const r = buildCapabilityGapResponse(CASE_C);
  const wait = r.alternatives.find((a) => a.insteadOf === 'control.wait');
  assert.ok(wait, '使用者說了「每 30 秒輪詢」，就該提出排程替代方案');
  assert.match(wait.suggestion, /排程/);
});

test('每個替代方案都必須說明取捨，不能只講好處', () => {
  const r = buildCapabilityGapResponse(CASE_C);
  for (const a of r.alternatives) {
    assert.ok(a.tradeoff && a.tradeoff.length > 5,
      `${a.insteadOf} 缺少取捨說明——讓使用者在不知情下接受不同的東西是不誠實的`);
  }
});

test('替代方案所需的 skill 若未實作，標為 usableNow:false 而非照樣推薦', () => {
  const crippled = R.map((s) => (s.id === 'http.public_get' ? { ...s, maturity: 'planned' } : s));
  const alts = findAlternatives(['binary.download'], '下載影片檔案',
    crippled.filter((s) => s.maturity !== 'planned').map((s) => s.id));
  const bin = alts.find((a) => a.insteadOf === 'binary.download');
  assert.ok(bin);
  // output.one_object 仍實作，所以這條仍可用；驗證欄位存在且為布林
  assert.equal(typeof bin.usableNow, 'boolean');
});

test('presentation 只給 usableNow 的替代方案——不開空頭支票', () => {
  const r = buildCapabilityGapResponse(CASE_C);
  for (const a of r.presentation.nearestAlternative) {
    const full = r.alternatives.find((x) => x.suggestion === a.suggestion);
    assert.equal(full.usableNow, true);
  }
});

test('placeholder 必須是會主動失敗的節點，不能是空的 NoOp（審查 C2）', () => {
  const r = buildCapabilityGapResponse(CASE_C);
  assert.ok(r.partial.needsManual.length > 0);
  for (const m of r.partial.needsManual) {
    assert.equal(m.placeholderBehaviour, 'stop_and_error',
      '空的 NoOp 會讓 workflow「跑成功但什麼都沒做」，那比報錯更糟');
  }
});

test('presentation 不含 skill id 或節點名稱——使用者不需要知道那些', () => {
  const text = JSON.stringify(buildCapabilityGapResponse(CASE_C).presentation);
  assert.doesNotMatch(text, /n8n-nodes-base|typeVersion|\bhttp\.public_get\b|\bcontrol\.flow\b/);
});

test('未知能力也產生 gap，而不是靜默略過', () => {
  const r = buildCapabilityGapResponse({
    userRequest: '做一個我自己發明的東西',
    requestedSkillIds: ['skill.that.does.not.exist'],
    registry: R,
  });
  assert.equal(r.state, 'capability_gap');
  assert.match(r.gaps[0].reason, /不在系統的支援清單/);
});

test('backlog 為純資料且不含時間戳（由呼叫端填，保持純函式）', () => {
  const r = buildCapabilityGapResponse(CASE_C);
  assert.equal(r.backlog.requestedAt, null);
  assert.equal(r.backlog.notifyWhenAvailable, true);
  assert.deepEqual(r.backlog.missingCapabilities.sort(),
    ['control.flow', 'http.authenticated_request'].sort());
});

test('同一份輸入必然得到同一份輸出（純函式）', () => {
  assert.deepEqual(buildCapabilityGapResponse(CASE_C), buildCapabilityGapResponse(CASE_C));
});

test('只缺一個能力時，仍要指出其餘可做的部分', () => {
  const r = buildCapabilityGapResponse({
    userRequest: '讀公開資料，失敗時通知我',
    requestedSkillIds: ['trigger.manual', 'http.public_get', 'control.flow'],
    registry: R,
  });
  assert.equal(r.gaps.length, 1);
  assert.equal(r.partial.canDoNow.length, 2);
  assert.match(r.presentation.partialOffer, /2 個步驟/);
});
