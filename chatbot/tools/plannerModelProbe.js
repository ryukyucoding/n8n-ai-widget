'use strict';
// planner 模型探針：測「某個模型能不能勝任 planner 位置」。
//
// 判準不是「輸出好不好看」，是「能不能通過 validatePlannerEnvelope → 審查 → 核准 → 編譯」。
// 任何一關擋下來就算失敗，並印出模型原始輸出，讓我們知道是哪裡不合規格。
//
// 用法：
//   OLLAMA_BASE_URL=http://<host>:11434 PLANNER_MODEL=qwen3.8:27b \
//     node chatbot/tools/plannerModelProbe.js
//   OPENAI_API_KEY=sk-... PLANNER_MODEL=gpt-4o OPENAI_BASE_URL=https://api.openai.com/v1 \
//     node chatbot/tools/plannerModelProbe.js
//
// 不寫入 n8n、不部署、不改任何檔案。純讀取 + 呼叫模型。

const path = require('node:path');
const SRC = path.join(__dirname, '..', 'src');
const { NODEWISE_PLANNER_RESULT_PROMPT } = require(path.join(SRC, 'nodewisePlannerPrompt'));
const { validatePlannerEnvelope } = require(path.join(SRC, 'nodewisePlannerEnvelope'));
const {
  reviewNodewisePlannerResult, approveNodewisePlan, compileApprovedNodewisePlan,
} = require(path.join(SRC, 'approvedNodewiseCompiler'));

const MODEL = process.env.PLANNER_MODEL || 'qwen3.8:27b';
const OLLAMA = process.env.OLLAMA_BASE_URL || '';
const OPENAI = process.env.OPENAI_API_KEY ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') : '';
const OLLAMA_OPENAI_COMPAT = /\/v1\/?$/.test(OLLAMA);
const SECRET = 'planner-probe-secret-value-32chr';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 120000);
const DEFAULT_READY_REQUEST = '幫我做一個流程：抓 jsonplaceholder 使用者 1 的基本資料，再抓他的 todo 清單，'
  + '最後輸出他的姓名、email、todo 總數，以及還沒完成的件數。';

const CASES = [
  {
    name: 'A 命中 skill library',
    request: process.env.PROBE_A_REQUEST || DEFAULT_READY_REQUEST,
    expect: 'ready_to_compile',
  },
  {
    name: 'B 超出 skill library',
    request: '幫我做一個流程：每天早上把 arXiv 的 RSS 摘要整理好，寄到我的 email 信箱。',
    expect: 'unsupported_capability',
  },
  {
    name: 'C 缺必要值',
    request: '幫我抓一個網站的資料然後統計一下。',
    expect: 'clarification_required',
  },
];

async function callModel(userRequest) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: NODEWISE_PLANNER_RESULT_PROMPT },
      { role: 'user', content: userRequest },
    ],
    stream: false,
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let url, headers = { 'Content-Type': 'application/json' };
    if (OPENAI || OLLAMA_OPENAI_COMPAT) {
      const base = OPENAI || OLLAMA;
      url = `${base.replace(/\/$/, '')}/chat/completions`;
      if (OPENAI) headers.Authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
      else if (process.env.OLLAMA_BASIC_AUTH) headers.Authorization = process.env.OLLAMA_BASIC_AUTH;
      body.response_format = { type: 'json_object' };
    } else {
      if (!OLLAMA) throw new Error('需要 OLLAMA_BASE_URL 或 OPENAI_API_KEY');
      url = `${OLLAMA.replace(/\/$/, '')}/api/chat`;
      body.format = 'json';           // Ollama 的 JSON 模式，大幅降低 markdown 包裹
      body.options = { temperature: 0 };
    }
    const started = Date.now();
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    const elapsed = Date.now() - started;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (OPENAI || OLLAMA_OPENAI_COMPAT)
      ? data.choices?.[0]?.message?.content
      : data.message?.content;
    return { text: String(text || ''), elapsed };
  } finally { clearTimeout(timer); }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}/);            // 容忍被 markdown 或前言包住
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

async function runCase(c) {
  const stages = [];
  const mark = (n, ok, detail) => stages.push({ n, ok, detail });
  let raw = '';
  try {
    const { text, elapsed } = await callModel(c.request);
    raw = text;
    mark('1 模型回應', true, `${elapsed} ms，${text.length} 字元`);

    const obj = parseJson(text);
    mark('2 JSON 可解析', !!obj, obj ? '' : '無法解析出 JSON 物件');
    if (!obj) return { stages, raw };

    try { validatePlannerEnvelope(obj); mark('3 envelope 合規', true, `outcome=${obj.outcome}`); }
    catch (e) { mark('3 envelope 合規', false, e.message); return { stages, raw }; }

    const outcomeOk = obj.outcome === c.expect;
    mark('4 outcome 正確', outcomeOk, `得到 ${obj.outcome}，預期 ${c.expect}`);

    const review = reviewNodewisePlannerResult(obj, {});
    mark('5 審查通過', true, `review.outcome=${review.outcome}`);

    if (obj.outcome === 'ready_to_compile') {
      const appr = approveNodewisePlan(obj.specification, { secret: SECRET, sessionId: 'probe' });
      const compiled = compileApprovedNodewisePlan(
        obj.specification, appr.approvalToken, { secret: SECRET, sessionId: 'probe' });
      mark('6 編譯成功', true,
        compiled.workflow.nodes.map((n) => n.type.replace('n8n-nodes-base.', '')).join(' → '));
    } else if (obj.outcome === 'unsupported_capability') {
      const gap = review.capabilityGap;
      const honest = gap && gap.state === 'capability_gap' && gap.partial.canDoNow.length === 0;
      mark('6 缺口誠實回報', !!honest,
        gap ? `state=${gap.state}, canDoNow=${gap.partial.canDoNow.length}` : '無 capabilityGap');
    } else {
      mark('6 問題可讀', Array.isArray(obj.requiredUserInputs) && obj.requiredUserInputs.length > 0,
        JSON.stringify(obj.requiredUserInputs || []));
    }
  } catch (e) { mark('!! 例外', false, e.message); }
  return { stages, raw };
}

(async () => {
  const endpoint = OPENAI ? `OpenAI ${OPENAI}`
    : OLLAMA_OPENAI_COMPAT ? `Ollama OpenAI-compatible ${OLLAMA}`
      : `Ollama ${OLLAMA}`;
  console.log(`模型：${MODEL}   端點：${endpoint}\n`);
  let passAll = 0;
  for (const c of CASES) {
    console.log('='.repeat(70));
    console.log(c.name);
    const { stages, raw } = await runCase(c);
    for (const s of stages) console.log(`  ${s.ok ? '✓' : '✗'} ${s.n}${s.detail ? '  — ' + s.detail : ''}`);
    const ok = stages.length > 0 && stages.every((s) => s.ok);
    if (ok) passAll += 1; else {
      console.log('  --- 模型原始輸出（前 900 字元）---');
      console.log(raw.slice(0, 900).split('\n').map((l) => '      ' + l).join('\n'));
    }
  }
  console.log('\n' + '='.repeat(70));
  console.log(`結果：${passAll}/${CASES.length} 個案例全關通過`);
  console.log(passAll === CASES.length
    ? '→ 這個模型可以坐 planner 的位置。'
    : '→ 尚不可用。上面的原始輸出指出卡在哪一關。');
})();
