'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkPublicHttpsUrl,
  assertPublicHttpsUrl,
  assertResolvesToPublicAddresses,
  classifyIp,
} = require('./publicUrlPolicy');

// --- 這些是 R3 回報的實際攻擊向量，加防線前全部會通過 ---
const MUST_BLOCK = [
  ['https://169.254.169.254/latest/meta-data/', '雲端 instance metadata'],
  ['https://169.254.170.2/v2/credentials', 'ECS task metadata'],
  ['https://127.0.0.1:5678/api/v1/credentials', 'n8n 自己的 API'],
  ['https://localhost/', 'loopback 名稱'],
  ['https://10.0.0.5/', 'RFC1918'],
  ['https://172.16.0.1/', 'RFC1918'],
  ['https://192.168.1.1/', 'RFC1918'],
  ['https://100.64.0.1/', 'CGNAT'],
  ['https://[::1]/', 'IPv6 loopback'],
  ['https://[fd00::1]/', 'IPv6 unique-local'],
  ['https://[fe80::1]/', 'IPv6 link-local'],
  ['https://[::ffff:169.254.169.254]/', 'IPv4-mapped 繞過'],
  ['https://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
  ['https://internal-jira.corp/rest/api/2/issue/1', '內部網域後綴'],
  ['https://n8n.local/', '.local'],
  ['https://buildserver/', '單標籤主機名稱'],
  ['http://example.com/', '非 https'],
  ['https://example.com:8080/', '非標準 port'],
  ['https://user:pass@example.com/', 'userinfo'],
  ['ftp://example.com/', '非 https protocol'],
  ['https://8.8.8.8/', '公開 IP literal 仍拒絕'],
  ['not a url', '無法解析'],
  ['', '空字串'],
];

for (const [url, label] of MUST_BLOCK) {
  test(`阻擋：${label} — ${url || '(空)'}`, () => {
    const result = checkPublicHttpsUrl(url);
    assert.equal(result.ok, false, `${url} 應被阻擋但通過了`);
    assert.ok(result.findings.length > 0, '必須說明阻擋原因');
    assert.throws(() => assertPublicHttpsUrl(url, 'steps[0].url'),
      /steps\[0\]\.url 未通過 public URL 政策/);
  });
}

const MUST_ALLOW = [
  'https://jsonplaceholder.typicode.com/todos?userId=2',
  'https://gql.twitch.tv/gql',
  'https://api.github.com/repos/n8n-io/n8n',
  'https://example.com:443/path',
  'https://sub.domain.example.co.uk/a/b?c=d#e',
];

for (const url of MUST_ALLOW) {
  test(`放行：${url}`, () => {
    const result = checkPublicHttpsUrl(url);
    assert.equal(result.ok, true, `${url} 應通過，findings=${result.findings.join('；')}`);
    assert.equal(result.isIpLiteral, false);
    assert.doesNotThrow(() => assertPublicHttpsUrl(url));
  });
}

test('classifyIp 邊界：網段起訖點', () => {
  assert.equal(classifyIp('10.255.255.255').blocked, true);
  assert.equal(classifyIp('11.0.0.0').blocked, false);
  assert.equal(classifyIp('172.15.255.255').blocked, false);
  assert.equal(classifyIp('172.16.0.0').blocked, true);
  assert.equal(classifyIp('172.31.255.255').blocked, true);
  assert.equal(classifyIp('172.32.0.0').blocked, false);
  assert.equal(classifyIp('100.63.255.255').blocked, false);
  assert.equal(classifyIp('100.64.0.0').blocked, true);
  assert.equal(classifyIp('100.127.255.255').blocked, true);
  assert.equal(classifyIp('100.128.0.0').blocked, false);
  assert.equal(classifyIp('169.253.255.255').blocked, false);
  assert.equal(classifyIp('169.254.0.1').blocked, true);
});

test('DNS 檢查：解析到內部位址時拒絕', async () => {
  const lookup = async () => [{ address: '10.0.0.7', family: 4 }];
  const result = await assertResolvesToPublicAddresses('evil.example.com', { lookup });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /10\.0\.0\.7/);
});

test('DNS 檢查：多筆位址中只要有一筆內部就拒絕', async () => {
  const lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ];
  const result = await assertResolvesToPublicAddresses('mixed.example.com', { lookup });
  assert.equal(result.ok, false, '混合回應必須拒絕——攻擊者可讓同名稱同時回公開與內部位址');
  assert.equal(result.findings.length, 1);
});

test('DNS 檢查：全部公開時通過', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const result = await assertResolvesToPublicAddresses('example.com', { lookup });
  assert.equal(result.ok, true);
  assert.deepEqual(result.addresses, ['93.184.216.34']);
});

test('DNS 檢查：解析失敗視為不通過，不是預設放行', async () => {
  const lookup = async () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; };
  const result = await assertResolvesToPublicAddresses('nx.example.com', { lookup });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /ENOTFOUND/);
});

// --- host allowlist（顯式傳入，無全域狀態；Codex 提案） ---
const { VERIFIED_PATTERN_HOSTS } = require('./publicUrlPolicy');

test('未傳 allowedHosts 時只套用 denylist', () => {
  assert.equal(checkPublicHttpsUrl('https://api.github.com/x').ok, true);
});

test('傳入 allowedHosts 後，不在名單上的公開主機被拒絕', () => {
  const opts = { allowedHosts: VERIFIED_PATTERN_HOSTS };
  assert.equal(checkPublicHttpsUrl('https://jsonplaceholder.typicode.com/todos', opts).ok, true);
  const blocked = checkPublicHttpsUrl('https://api.github.com/x', opts);
  assert.equal(blocked.ok, false);
  assert.match(blocked.findings.join(' '), /not an approved DNS hostname/);
});

test('allowlist 不能讓私有位址通過（denylist 為第二道防線）', () => {
  const opts = { allowedHosts: ['169.254.169.254', 'evil.example.com'] };
  assert.equal(checkPublicHttpsUrl('https://169.254.169.254/', opts).ok, false,
    'IP literal 即使被列進 allowlist 也必須擋——allowlist 設錯時 denylist 要接住');
});

test('沒有模組層可變狀態：兩次不同 allowlist 的呼叫互不影響', () => {
  assert.equal(checkPublicHttpsUrl('https://api.github.com/x', { allowedHosts: [] }).ok, false);
  assert.equal(checkPublicHttpsUrl('https://api.github.com/x').ok, true,
    '前一次呼叫不得洩漏狀態到下一次');
});
