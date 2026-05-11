'use strict';

/**
 * Fix IPv6 literals in http(s) authority: `http://fd12:...::1:5678` → `http://[fd12:...::1]:5678`.
 * Undici (Node fetch) and many clients parse unbracketed IPv6 as host:port → "Invalid port: 'b51a:cc66:f0::'".
 *
 * Applies to **target URLs** and to **HTTP(S)_PROXY / ALL_PROXY** (fetch uses these automatically).
 */
function normalizeHttpUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return s;

  const m = s.match(/^(https?):\/\/([^/?#]+)(.*)$/i);
  if (!m) return s;

  const proto = m[1].toLowerCase();
  const authority = m[2];
  const pathAndRest = m[3] || '';

  if (authority.startsWith('[')) {
    return `${proto}://${authority}${pathAndRest}`;
  }

  const lastColon = authority.lastIndexOf(':');
  if (lastColon === -1) {
    return `${proto}://${authority}${pathAndRest}`;
  }

  const afterLast = authority.slice(lastColon + 1);
  if (/^\d+$/.test(afterLast)) {
    const host = authority.slice(0, lastColon);
    if (host.includes(':')) {
      return `${proto}://[${host}]:${afterLast}${pathAndRest}`;
    }
    return `${proto}://${authority}${pathAndRest}`;
  }

  if (authority.includes(':')) {
    return `${proto}://[${authority}]${pathAndRest}`;
  }

  return `${proto}://${authority}${pathAndRest}`;
}

function normalizeN8nBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return normalizeHttpUrl('http://localhost:5678').replace(/\/+$/, '');
  return normalizeHttpUrl(s).replace(/\/+$/, '');
}

/** Mutates process.env so global fetch / OpenAI / child processes see fixed URLs. */
function sanitizeProxyEnv() {
  const keys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'OPENAI_BASE_URL',
  ];
  for (const k of keys) {
    const v = process.env[k];
    if (!v || typeof v !== 'string') continue;
    const n = normalizeHttpUrl(v);
    if (n !== v) {
      process.env[k] = n;
      console.warn(`[n8n-ai-widget] Normalized ${k} (IPv6 in URL must use brackets)`);
    }
  }
}

module.exports = { normalizeHttpUrl, normalizeN8nBaseUrl, sanitizeProxyEnv };
