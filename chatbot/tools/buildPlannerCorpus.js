#!/usr/bin/env node
'use strict';

// planner 語料產生器
//
// 目的：把「換一個模型好不好」從人工判斷變成跑一支腳本。
//
// 產生的案例全部是機械推導的，沒有人工標記，因此：
//   1. 一次可以生出上百個
//   2. skill library 一成長，重跑就自動更新標記——
//      今天預期被拒絕的題目，補完能力之後會自動變成預期成功
//   3. 不需要模型、不需要網路，純資料處理
//
// 用法：
//   node chatbot/tools/buildPlannerCorpus.js \
//     --easy100 <testing_data_low_100.jsonl> \
//     --output chatbot/corpus/planner_corpus.json
//
// 四類案例：
//   easy100          真實需求描述，標記由能力稽核推導（測「該拒絕的有沒有拒絕」）
//   generalization   由 registry 組合生成（測「該做到的有沒有做到」，且不是照抄 prompt 範例）
//   clarification    刻意缺少必要值（測「缺資訊時會不會問」）
//   compiler_reject  規格層負向案例，**不需要模型**（測編譯器的守門）

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const { auditRecords, extractRecord } = require(path.join(SRC, 'easy100CapabilityCoverage'));
const { SOURCES } = require(path.join(SRC, 'sourceSchemaRegistry'));
const { assertCorpusSourceAllowed } = require('./corpusQuarantine');

function argOf(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// 1. Easy-100：真實需求描述 + 由能力稽核推導的標記
// ---------------------------------------------------------------------------
function fromEasy100(jsonlPath) {
  assertCorpusSourceAllowed(jsonlPath);
  const text = fs.readFileSync(jsonlPath, 'utf8');
  const records = [];
  let line = 0;
  for (const raw of text.split('\n')) {
    line += 1;
    if (!raw.trim()) continue;
    try { records.push(extractRecord(raw, line)); } catch (_) { /* 解析失敗的略過，另計 */ }
  }
  const report = auditRecords(records);
  const byId = new Map(report.cases.map((c) => [c.caseId, c]));

  return records.map((record) => {
    const audited = byId.get(record.caseId);
    const blockers = audited ? audited.blockers.map((b) => b.key) : [];
    // 標記推導：沒有任何缺口才可能編譯得出來。
    // 這是保守的——它只說「不該宣稱做得到」，不保證規格細節正確。
    const expectedOutcome = blockers.length === 0 ? 'ready_to_compile' : 'unsupported_capability';
    return {
      id: `easy100-${record.caseId}`,
      group: 'easy100',
      request: String(record.description || '').replace(/^需求描述：/, '').trim(),
      expectedOutcome,
      rationale: blockers.length === 0
        ? '所有需要的能力都已實作'
        : `缺少能力：${blockers.join(', ')}`,
      derivedFrom: 'easy100CapabilityCoverage',
    };
  });
}

// ---------------------------------------------------------------------------
// 2. 泛化：由 registry 組合生成，專門測「不是照抄 prompt 範例」
// ---------------------------------------------------------------------------
function generalizationCases() {
  const user = SOURCES.find((s) => s.id === 'jsonplaceholder.user');
  const todos = SOURCES.find((s) => s.id === 'jsonplaceholder.todos');
  if (!user || !todos) return [];

  const cases = [];
  const stringFields = Object.entries(user.fields)
    .filter(([, t]) => t === 'string').map(([n]) => n);

  // 換 id × 換欄位子集。prompt 的範例固定是 user 1 + 四個欄位，
  // 所以這裡刻意避開那個組合。
  for (const id of [2, 3, 5, 7, 9]) {
    for (const fields of [['name'], ['name', 'email'], ['username', 'phone']]) {
      cases.push({
        id: `gen-user${id}-${fields.join('+')}`,
        group: 'generalization',
        request: `幫我做一個流程：抓 JSONPlaceholder 使用者 ${id} 的資料，只輸出${fields.map(zh).join('和')}。`,
        expectedOutcome: 'ready_to_compile',
        expect: { urlContains: [`/users/${id}`], outputFields: fields },
        rationale: '單一來源 + select_fields，能力範圍內；刻意不使用 prompt 範例的組合',
      });
    }
  }
  // 加上 todo 統計的變體
  for (const id of [2, 4, 8]) {
    cases.push({
      id: `gen-todo-user${id}`,
      group: 'generalization',
      request: `幫我做一個流程：抓 JSONPlaceholder 使用者 ${id} 的資料和他的 todo 清單，`
        + '輸出姓名以及還沒完成的件數。',
      expectedOutcome: 'ready_to_compile',
      expect: { urlContains: [`/users/${id}`, `userId=${id}`], outputFields: ['name', 'incompleteTodos'] },
      rationale: '兩個來源 + join 統計，能力範圍內',
    });
  }
  void stringFields;
  return cases;
}

function zh(field) {
  return ({ name: '姓名', email: 'email', username: '帳號', phone: '電話', website: '網站' })[field] || field;
}

// ---------------------------------------------------------------------------
// 3. 缺必要值：測「不會亂猜，會回頭問」
// ---------------------------------------------------------------------------
function clarificationCases() {
  return [
    '幫我抓一個網站的資料然後統計一下。',
    '做一個流程，把某個使用者的資料整理出來。',
    '我要一個會定時抓資料的流程。',
    '幫我算一下有幾件事情還沒做完。',
    '抓 JSONPlaceholder 的資料給我。',
    '做個 workflow 輸出一些欄位就好。',
  ].map((request, i) => ({
    id: `clarify-${i + 1}`,
    group: 'clarification',
    request,
    expectedOutcome: 'clarification_required',
    rationale: '缺少必要值（對象、來源或輸出欄位未指定），不得自行猜測',
  }));
}

// ---------------------------------------------------------------------------
// 4. 編譯器層負向案例：**不需要模型**，可在任何環境跑
// ---------------------------------------------------------------------------
function compilerRejectCases() {
  const cases = [];
  const push = (id, why, mutate) => cases.push({
    id: `reject-${id}`, group: 'compiler_reject', expectedOutcome: 'reject',
    rationale: why, mutate,
  });

  for (const source of SOURCES) {
    const url = `https://${source.host}${source.path.replace(/:(\w+)/g, '1')}`;
    push(`${source.id}-unknown-field`, `${source.id} 引用未宣告的欄位`,
      { kind: 'unknown_field', url, cardinality: source.cardinality, field: '__no_such_field__' });
    const wrongCard = source.cardinality === 'items' ? 'one_object' : 'items';
    push(`${source.id}-cardinality`, `${source.id} 基數宣告與實際回傳相反`,
      { kind: 'wrong_cardinality', url, cardinality: wrongCard });
    const nonBool = Object.entries(source.fields).find(([, t]) => t !== 'boolean');
    if (nonBool) {
      push(`${source.id}-type`, `${source.id}.${nonBool[0]} 是 ${nonBool[1]}，用於布林統計`,
        { kind: 'wrong_type', url, cardinality: source.cardinality, field: nonBool[0] });
    }
  }
  // 同主機但未登錄的路徑——證明來源登錄獨立於主機允許清單生效
  for (const p of ['/albums/1', '/posts/1', '/comments/1']) {
    push(`unregistered${p.replace(/\W/g, '-')}`, `允許清單主機上的未登錄路徑 ${p}`,
      { kind: 'unregistered', url: `https://jsonplaceholder.typicode.com${p}`, cardinality: 'one_object' });
  }
  return cases;
}

// ---------------------------------------------------------------------------

function main() {
  const easyPath = argOf('--easy100');
  const outPath = argOf('--output', path.join(__dirname, '..', 'corpus', 'planner_corpus.json'));

  const groups = [];
  if (easyPath) {
    if (!fs.existsSync(easyPath)) throw new Error(`找不到 Easy-100 資料：${easyPath}`);
    groups.push(...fromEasy100(easyPath));
  }
  groups.push(...generalizationCases(), ...clarificationCases(), ...compilerRejectCases());

  const counts = groups.reduce((acc, c) => {
    acc[c.group] = (acc[c.group] || 0) + 1;
    acc[`outcome:${c.expectedOutcome}`] = (acc[`outcome:${c.expectedOutcome}`] || 0) + 1;
    return acc;
  }, {});

  const corpus = {
    schemaVersion: '1.0',
    kind: 'planner_corpus',
    generatedAt: new Date().toISOString(),
    note: '標記由能力稽核與 registry 機械推導。skill library 成長後重跑本工具，標記會自動更新。',
    counts,
    cases: groups,
  };

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(corpus, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: outPath, total: groups.length, counts }, null, 2)}\n`);
}

if (require.main === module) main();
module.exports = { fromEasy100, generalizationCases, clarificationCases, compilerRejectCases };
