#!/usr/bin/env node
'use strict';

// planner 語料執行器 —— 把「換一個模型好不好」變成一個可比較的數字。
//
// 兩種模式：
//   --level compiler   只跑編譯器層案例。**不需要模型、不需要網路**，任何環境都能跑。
//   --level planner    跑自然語言案例，需要可呼叫的模型端點。
//
// 用法：
//   node chatbot/tools/runPlannerCorpus.js --level compiler
//   OLLAMA_BASE_URL=... OLLAMA_BASIC_AUTH=... \
//     node chatbot/tools/runPlannerCorpus.js --level planner --model qwen3.8:27b
//
// 不寫入 n8n、不部署、不改任何檔案。

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const { reviewNodewisePlannerResult } = require(path.join(SRC, 'approvedNodewiseCompiler'));
const { validateSpecification } = require(path.join(SRC, 'nodewiseCompiler'));
const { assertCorpusArtifactAllowed } = require('./corpusQuarantine');

function argOf(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// --- 編譯器層：由 mutate 描述組出一份「應該被拒絕」的規格 -------------------
function specFromMutation(m) {
  const spec = {
    schemaVersion: '1.0', kind: 'nodewise_step_specification', goal: 'corpus probe',
    requiredUserSetup: [],
    expectedOutput: { deliveryShape: 'one_object', fields: ['out'] },
    steps: [
      { id: 'start', capability: 'manual_trigger', requiredUserSetup: [], configuration: {} },
      { id: 'src', capability: 'http_request', requiredUserSetup: [], configuration: {
        method: 'GET',
        url: { kind: 'public_literal', reference: m.url, cardinality: m.cardinality } } },
    ],
  };
  if (m.kind === 'wrong_type') {
    spec.expectedOutput.fields = ['total', 'falseCount'];
    spec.steps.push({ id: 'agg', capability: 'data_transform', requiredUserSetup: [], configuration: {
      operation: 'count_false_boolean',
      input: { kind: 'prior_step', reference: 'src.response', cardinality: 'items' },
      field: m.field, totalField: 'total', falseCountField: 'falseCount' } });
  } else {
    spec.steps.push({ id: 'pick', capability: 'data_transform', requiredUserSetup: [], configuration: {
      operation: 'select_fields',
      input: { kind: 'prior_step', reference: 'src.response', cardinality: 'one_object' },
      mappings: [{ from: m.field || 'id', to: 'out', valueType: 'string' }] } });
  }
  return spec;
}

function runCompilerLevel(cases) {
  const rows = [];
  for (const c of cases) {
    let outcome = 'accepted';
    let detail = '';
    try {
      validateSpecification(specFromMutation(c.mutate));
    } catch (e) {
      outcome = 'reject';
      detail = String(e.message).split('。')[0].slice(0, 90);
    }
    rows.push({ id: c.id, expected: c.expectedOutcome, actual: outcome,
      pass: outcome === c.expectedOutcome, detail, rationale: c.rationale });
  }
  return rows;
}

// --- planner 層：呼叫模型、驗證回覆、比對預期結果 --------------------------
async function runPlannerLevel(cases, { model, concurrency = 1 }) {
  const OpenAI = require('openai');
  const { NODEWISE_PLANNER_RESULT_PROMPT } = require(path.join(SRC, 'nodewisePlannerPrompt'));
  const { parsePlannerResponse } = require(path.join(SRC, 'nodewisePlanner'));
  const { validatePlannerEnvelope } = require(path.join(SRC, 'nodewisePlannerEnvelope'));

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'ollama-key',
    baseURL: process.env.OLLAMA_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
    defaultHeaders: process.env.OLLAMA_BASIC_AUTH
      ? { Authorization: process.env.OLLAMA_BASIC_AUTH } : undefined,
  });

  const rows = [];
  let index = 0;
  async function worker() {
    for (;;) {
      const i = index; index += 1;
      if (i >= cases.length) return;
      const c = cases[i];
      const started = Date.now();
      const row = { id: c.id, group: c.group, expected: c.expectedOutcome, actual: null,
        pass: false, ms: 0, detail: '' };
      try {
        const response = await client.chat.completions.create({
          model, max_tokens: 2600, response_format: { type: 'json_object' }, temperature: 0,
          messages: [
            { role: 'system', content: NODEWISE_PLANNER_RESULT_PROMPT },
            { role: 'user', content: c.request },
          ],
        });
        row.ms = Date.now() - started;
        const content = response.choices?.[0]?.message?.content;
        if (response.choices?.[0]?.finish_reason === 'length') {
          row.actual = 'truncated'; row.detail = '被 max_tokens 截斷'; rows.push(row); continue;
        }
        const envelope = validatePlannerEnvelope(parsePlannerResponse(content));
        row.actual = envelope.outcome;
        row.pass = envelope.outcome === c.expectedOutcome;
        // ready_to_compile 還要看規格是否真的通得過審查與編譯
        if (envelope.outcome === 'ready_to_compile') {
          try {
            reviewNodewisePlannerResult(envelope, {});
            if (c.expect) {
              const text = JSON.stringify(envelope.specification);
              for (const needle of c.expect.urlContains || []) {
                if (!text.includes(needle)) {
                  row.pass = false; row.detail = `規格未包含 ${needle}（可能是照抄範例）`;
                }
              }
              const fields = envelope.specification?.expectedOutput?.fields || [];
              if (c.expect.outputFields
                && JSON.stringify(fields) !== JSON.stringify(c.expect.outputFields)) {
                row.pass = false;
                row.detail = row.detail || `輸出欄位 ${JSON.stringify(fields)} 與預期不符`;
              }
            }
          } catch (e) {
            row.pass = false; row.detail = `規格未通過審查：${String(e.message).slice(0, 70)}`;
          }
        }
      } catch (e) {
        row.ms = Date.now() - started;
        row.actual = 'error';
        row.detail = String(e.message).slice(0, 90);
      }
      rows.push(row);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return rows;
}

function summarise(rows, label) {
  const pass = rows.filter((r) => r.pass).length;
  const byGroup = {};
  for (const r of rows) {
    const g = r.group || 'compiler_reject';
    byGroup[g] = byGroup[g] || { pass: 0, total: 0 };
    byGroup[g].total += 1;
    if (r.pass) byGroup[g].pass += 1;
  }
  const times = rows.map((r) => r.ms).filter(Boolean).sort((a, b) => a - b);
  return {
    label,
    score: `${pass}/${rows.length}`,
    rate: rows.length ? Number((pass / rows.length).toFixed(3)) : 0,
    byGroup,
    medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
    failures: rows.filter((r) => !r.pass)
      .map((r) => ({ id: r.id, expected: r.expected, actual: r.actual, detail: r.detail })),
  };
}

async function main() {
  const corpusPath = argOf('--corpus', path.join(__dirname, '..', 'corpus', 'planner_corpus.json'));
  const level = argOf('--level', 'compiler');
  const model = argOf('--model', process.env.PLAN_FIRST_PLANNER_MODEL || 'qwen3.8:27b');
  const outPath = argOf('--output', null);
  const limit = Number(argOf('--limit', '0')) || 0;
  const concurrency = Number(argOf('--concurrency', '2')) || 2;

  assertCorpusArtifactAllowed(corpusPath);
  const corpus = JSON.parse(fs.readFileSync(path.resolve(corpusPath), 'utf8'));
  let cases = corpus.cases.filter((c) => (level === 'compiler'
    ? c.group === 'compiler_reject' : c.group !== 'compiler_reject'));
  if (limit) cases = cases.slice(0, limit);

  const rows = level === 'compiler'
    ? runCompilerLevel(cases)
    : await runPlannerLevel(cases, { model, concurrency });

  const summary = summarise(rows, level === 'compiler' ? 'compiler' : `planner:${model}`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath),
      `${JSON.stringify({ summary, rows, corpusGeneratedAt: corpus.generatedAt }, null, 2)}\n`);
  }
  if (summary.rate < 1 && level === 'compiler') process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { runCompilerLevel, runPlannerLevel, summarise };
