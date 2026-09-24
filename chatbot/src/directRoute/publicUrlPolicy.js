'use strict';

// R3: n8n runtime 跑在使用者的網路內部，而 compiler 消費的 URL 來自 LLM 產生的
// specification。因此「public HTTPS GET」這件事必須被強制，不能只寫在規格裡。
//
// 未加防線時以下全部合法通過（實測 2026-08-28，nodewiseCompiler L33-35 僅檢查 protocol）：
//   https://169.254.169.254/latest/meta-data/   雲端 instance metadata，憑證竊取標準路徑
//   https://10.0.0.5:8080/ , https://192.168.1.1/   內網服務
//   https://127.0.0.1:5678/api/v1/credentials       n8n 自己的 API
//
// 本模組只做 compile-time 的靜態與 DNS 檢查。執行期 DNS rebinding 無法由此攔截，
// 見底部 RESIDUAL_RISKS。

const dns = require('node:dns');
const net = require('node:net');

const ALLOWED_PROTOCOLS = new Set(['https:']);
const ALLOWED_PORTS = new Set(['', '443']);

// 主機名稱後綴：這些一律指向內部網路
const BLOCKED_SUFFIXES = [
  '.local', '.localdomain', '.internal', '.intranet', '.corp', '.lan',
  '.home.arpa', '.in-addr.arpa', '.ip6.arpa', '.onion',
];
const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

// IPv4 保留 / 私有網段。[network, prefixLength, 說明]
const BLOCKED_V4 = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'RFC1918 private'],
  ['100.64.0.0', 10, 'CGNAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud metadata)'],
  ['172.16.0.0', 12, 'RFC1918 private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'TEST-NET-1'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'RFC1918 private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'TEST-NET-2'],
  ['203.0.113.0', 24, 'TEST-NET-3'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function v4ToInt(address) {
  return address.split('.').reduce((acc, octet) => ((acc << 8) >>> 0) + Number(octet), 0) >>> 0;
}

function v4InBlock(address, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (v4ToInt(address) & mask) === (v4ToInt(network) & mask);
}

// IPv6 中以 ::ffff:a.b.c.d 或 ::a.b.c.d 形式夾帶的 IPv4，必須還原後重新檢查，
// 否則 https://[::ffff:169.254.169.254]/ 會繞過 v4 規則。
function extractMappedV4(address) {
  const m = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m ? m[1] : null;
}

function classifyIp(address) {
  if (net.isIPv4(address)) {
    for (const [network, prefix, label] of BLOCKED_V4) {
      if (v4InBlock(address, network, prefix)) return { blocked: true, reason: label };
    }
    return { blocked: false };
  }
  if (net.isIPv6(address)) {
    const mapped = extractMappedV4(address);
    if (mapped) {
      const inner = classifyIp(mapped);
      return inner.blocked
        ? { blocked: true, reason: `IPv4-mapped ${mapped} (${inner.reason})` }
        : { blocked: false };
    }
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return { blocked: true, reason: 'IPv6 loopback/unspecified' };
    const head = lower.split(':')[0];
    // fc00::/7 unique-local, fe80::/10 link-local
    if (/^f[cd]/.test(head)) return { blocked: true, reason: 'IPv6 unique-local (fc00::/7)' };
    if (/^fe[89ab]/.test(head)) return { blocked: true, reason: 'IPv6 link-local (fe80::/10)' };
    if (/^ff/.test(head)) return { blocked: true, reason: 'IPv6 multicast' };
    return { blocked: false };
  }
  return { blocked: true, reason: 'unparseable address' };
}

// Host allowlist。設計歷程值得留著：
//   Claude 初版用「模組層可變狀態 + setAllowedHosts()」，Codex 於
//   codex-20260828T055236Z-004 指出兩個問題——(a) 預設空白等於 beta 沒有受驗證主機邊界，
//   nodewiseCompiler 會放行 example.com；(b) 全域狀態讓不同 capability 無法各自帶自己的名單。
//   他的提案正確，已改為「每次呼叫顯式傳入 allowedHosts」，沒有任何模組層可變狀態。
//
//   allowlist 與 denylist 是縱深防禦，不是二選一：
//     allowlist 決定「可以連誰」，denylist 是 allowlist 設錯或被繞過時的第二道防線。
//   因此即使某主機在 allowlist 上，只要它是 IP literal 或解析到保留網段，一樣拒絕。

// 目前受驗證 pattern 實際用到的主機。
const VERIFIED_PATTERN_HOSTS = Object.freeze([
  'jsonplaceholder.typicode.com',
]);

function normalizeHosts(hosts) {
  if (hosts == null) return null;                       // null = 不套用 allowlist
  if (!Array.isArray(hosts)) throw new Error('allowedHosts must be an array or null');
  return new Set(hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean));
}

/**
 * 靜態檢查。不需網路，compiler 一律執行。
 * @param {{allowedHosts?: string[]|null}} options allowedHosts 為陣列時強制 allowlist；
 *        null 代表只套用 denylist。呼叫端必須自行決定，沒有全域預設。
 * @returns {{ok: boolean, findings: string[], hostname: string|null, isIpLiteral: boolean}}
 */
function checkPublicHttpsUrl(value, { allowedHosts = null } = {}) {
  const findings = [];
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, findings: ['URL 必須是非空字串'], hostname: null, isIpLiteral: false };
  }

  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return { ok: false, findings: [`URL 無法解析：${error.message}`], hostname: null, isIpLiteral: false };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    findings.push(`只允許 HTTPS，收到 ${url.protocol} / must use HTTPS`);
  }
  if (url.username || url.password) {
    findings.push('URL 不得包含 userinfo（user:pass@host）');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    findings.push(`只允許標準 https port 443，收到 ${url.port}`);
  }

  // URL 會把 [::1] 正規化為含中括號的 host；hostname 已去除中括號
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isIpLiteral = net.isIP(hostname) !== 0;

  if (isIpLiteral) {
    const verdict = classifyIp(hostname);
    if (verdict.blocked) {
      findings.push(`禁止連往非公開位址 / private address: ${hostname} (${verdict.reason})`);
    } else {
      // 公開 IP literal 仍然拒絕：規格宣稱的是「固定公開 HTTPS GET」，
      // 而 IP literal 幾乎必然是繞過名稱檢查的嘗試，不是正常的公開 API 用法。
      findings.push(`不接受 IP literal 作為主機 / not an approved DNS hostname: ${hostname}`);
    }
  } else {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      findings.push(`禁止連往 / private address: ${hostname}`);
    }
    if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      findings.push(`禁止內部網域後綴 / not an approved DNS hostname: ${hostname}`);
    }
    if (!hostname.includes('.')) {
      findings.push(`單標籤主機名稱會解析到內部網路 / not an approved DNS hostname: ${hostname}`);
    }
    const allowed = normalizeHosts(allowedHosts);
    if (allowed && !allowed.has(hostname)) {
      findings.push(`${hostname} 不在 allowlist 中 / not an approved DNS hostname`);
    }
  }

  return { ok: findings.length === 0, findings, hostname, isIpLiteral };
}

/**
 * DNS 檢查。需要網路，因此為選用；呼叫端在可連網時應執行。
 * 解析主機名稱並檢查「每一個」回傳位址——只要有一個落在保留網段就拒絕，
 * 因為攻擊者可讓同一名稱同時回傳公開與內部位址。
 */
async function assertResolvesToPublicAddresses(hostname, { lookup } = {}) {
  const resolve = lookup || ((name) => dns.promises.lookup(name, { all: true, verbatim: true }));
  let records;
  try {
    records = await resolve(hostname);
  } catch (error) {
    return { ok: false, findings: [`無法解析主機名稱 ${hostname}：${error.code || error.message}`], addresses: [] };
  }
  const addresses = (records || []).map((record) => record.address);
  if (!addresses.length) {
    return { ok: false, findings: [`${hostname} 沒有解析到任何位址`], addresses: [] };
  }
  const findings = [];
  for (const address of addresses) {
    const verdict = classifyIp(address);
    if (verdict.blocked) {
      findings.push(`${hostname} 解析到非公開位址 / resolves to private address ${address} (${verdict.reason})`);
    }
  }
  return { ok: findings.length === 0, findings, addresses };
}

/** compiler 用的斷言版本：不通過就丟例外，訊息含全部 findings。 */
function assertPublicHttpsUrl(value, field = 'url', options = {}) {
  const result = checkPublicHttpsUrl(value, options);
  if (!result.ok) {
    throw new Error(`${field} 未通過 public URL 政策：${result.findings.join('；')}`);
  }
  return result;
}

// 誠實記錄：本模組擋不住的事。規格 §6 應引用這段，不得宣稱已完全防護。
const RESIDUAL_RISKS = Object.freeze([
  'DNS rebinding：compile 時解析到公開位址，執行時可能改為內部位址。除非 n8n 端在發出請求前重新檢查，否則此風險存在。',
  '公開網域上的 open redirect 或 SSRF proxy 可被用來間接觸及內部資源。',
  '本政策不檢查回應內容，也不限制回應大小。',
]);

// `validatePublicHttpsUrl` 是 Codex 在 nodewiseCompiler.js 使用的名稱。
// 2026-08-28 我（Claude）在建立本模組時不知道他已經寫了呼叫端，用了不同的命名，
// 導致 require 取到 undefined —— 檔案照樣載入成功，但一呼叫就 TypeError。
// 保留此別名讓他的呼叫端可用；命名要不要收斂由兩人議定，不單方面改對方的呼叫端。
const validatePublicHttpsUrl = (value, field = 'url', options = {}) =>
  assertPublicHttpsUrl(value, field, options);

module.exports = {
  checkPublicHttpsUrl,
  validatePublicHttpsUrl,
  VERIFIED_PATTERN_HOSTS,
  assertPublicHttpsUrl,
  assertResolvesToPublicAddresses,
  classifyIp,
  RESIDUAL_RISKS,
  BLOCKED_V4,
  BLOCKED_SUFFIXES,
};
