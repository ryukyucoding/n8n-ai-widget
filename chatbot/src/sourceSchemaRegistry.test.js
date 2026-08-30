'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOURCES, resolveSource, assertSourceRegistered, assertField,
  assertCardinality, describeForPlanner, sourceRegistryRevision,
} = require('./sourceSchemaRegistry');

const USER = 'https://jsonplaceholder.typicode.com/users/5';
const TODOS = 'https://jsonplaceholder.typicode.com/todos?userId=5';

test('比對已登錄的來源，帶查詢字串不影響', () => {
  assert.equal(resolveSource(USER).id, 'jsonplaceholder.user');
  assert.equal(resolveSource(TODOS).id, 'jsonplaceholder.todos');
});

test(':id 只吃單一區段，不會吞掉更深的路徑', () => {
  assert.equal(resolveSource('https://jsonplaceholder.typicode.com/users/5/todos').id,
    'jsonplaceholder.user.todos');
  assert.equal(resolveSource('https://jsonplaceholder.typicode.com/users/5/todos/9'), null);
});

test('未登錄的主機與路徑一律回 null，不猜', () => {
  assert.equal(resolveSource('https://api.github.com/users/octocat'), null);
  assert.equal(resolveSource('https://jsonplaceholder.typicode.com/albums/1'), null);
});

test('非 https 與畸形 URL 回 null', () => {
  assert.equal(resolveSource('http://jsonplaceholder.typicode.com/users/5'), null);
  assert.equal(resolveSource('not a url'), null);
  assert.equal(resolveSource(''), null);
});

test('assertSourceRegistered 對未登錄來源丟出可行動的訊息', () => {
  assert.throws(() => assertSourceRegistered('https://api.github.com/users/octocat', 'steps[1].url'),
    /沒有登錄的回應 schema/);
  assert.equal(assertSourceRegistered(USER).id, 'jsonplaceholder.user');
});

test('比對到多個來源時拒絕，不任選一個', () => {
  const ambiguous = [
    { id: 'a', host: 'x.test', path: '/a/:id', cardinality: 'one_object', fields: { id: 'number' } },
    { id: 'b', host: 'x.test', path: '/a/:name', cardinality: 'one_object', fields: { id: 'number' } },
  ];
  assert.throws(() => resolveSource('https://x.test/a/1', ambiguous), /比對到多個登錄項目/);
});

// --- 欄位驗證：這是擋住「跑得動但是錯的」的關鍵 ---

test('未宣告的欄位被擋下，並列出可用欄位', () => {
  const user = resolveSource(USER);
  assert.throws(() => assertField(user, 'this_field_does_not_exist'),
    /沒有宣告欄位 this_field_does_not_exist/);
  try { assertField(user, 'nope'); } catch (e) {
    assert.match(e.message, /已宣告的欄位：.*name.*email/);
  }
});

test('已宣告的欄位通過並回傳型別', () => {
  assert.equal(assertField(resolveSource(USER), 'name'), 'string');
  assert.equal(assertField(resolveSource(TODOS), 'completed'), 'boolean');
});

test('型別不符被擋下——這是 count_false_boolean 安靜給出 0 的成因', () => {
  const todos = resolveSource(TODOS);
  // title 是 string，拿去做 `record.title === false` 永遠是 false，計數會安靜地變成 0
  assert.throws(
    () => assertField(todos, 'title', { expectedType: 'boolean', usedBy: 'count_false_boolean' }),
    /型別是 string.*需要 boolean/s,
  );
  assert.doesNotThrow(
    () => assertField(todos, 'completed', { expectedType: 'boolean', usedBy: 'count_false_boolean' }),
  );
});

test('型別錯誤訊息要說明為什麼在編譯期擋而不是留到執行期', () => {
  try {
    assertField(resolveSource(TODOS), 'title', { expectedType: 'boolean' });
  } catch (e) {
    assert.match(e.message, /不會在執行時報錯/);
  }
});

test('基數不符被擋下', () => {
  assert.throws(() => assertCardinality(resolveSource(USER), 'items'),
    /回傳的是 one_object.*宣告 items/);
  assert.equal(assertCardinality(resolveSource(TODOS), 'items'), 'items');
});

// --- prompt 同步與版本綁定 ---

test('describeForPlanner 涵蓋每個來源與其欄位', () => {
  const text = describeForPlanner();
  for (const source of SOURCES) {
    assert.ok(text.includes(source.host + source.path), `缺少 ${source.id}`);
    for (const name of Object.keys(source.fields)) {
      assert.ok(text.includes(name), `${source.id} 缺少欄位 ${name}`);
    }
  }
});

test('登錄清單改變時版本摘要跟著改變（可綁進 approval token）', () => {
  const before = sourceRegistryRevision();
  assert.equal(before, sourceRegistryRevision(), '同一份清單必須穩定');
  const changed = SOURCES.map((s) => (s.id === 'jsonplaceholder.user'
    ? { ...s, fields: { ...s.fields, newField: 'string' } } : s));
  assert.notEqual(sourceRegistryRevision(changed), before);
});

test('每個登錄來源都必須有 verifiedAt 與合法型別', () => {
  for (const source of SOURCES) {
    assert.ok(source.verifiedAt, `${source.id} 缺少 verifiedAt：`
      + '登錄前必須有人實際打過該端點並核對欄位，不能照文件抄');
    for (const [name, type] of Object.entries(source.fields)) {
      assert.ok(['string', 'number', 'boolean'].includes(type),
        `${source.id}.${name} 的型別 ${type} 不在支援範圍`);
    }
  }
});
