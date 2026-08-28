'use strict';

const DEFAULT_ALLOWED_PUBLIC_HOSTS = Object.freeze(['jsonplaceholder.typicode.com']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isIpv4Literal(hostname) {
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isPrivateIpv4(hostname) {
  if (!isIpv4Literal(hostname)) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 10
    || first === 127
    || first === 0
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

// This is a compile-time policy only. Runtime DNS rebinding protection must be
// enforced by the execution environment before arbitrary user-approved hosts exist.
function validatePublicHttpsUrl(value, allowedHosts = DEFAULT_ALLOWED_PUBLIC_HOSTS) {
  assert(typeof value === 'string' && value.trim(), 'public URL is required');
  assert(Array.isArray(allowedHosts) && allowedHosts.length > 0, 'allowedHosts must be a non-empty array');
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const approved = new Set(allowedHosts.map((host) => String(host).toLowerCase()));

  assert(url.protocol === 'https:', 'public URL must use HTTPS');
  assert(!url.username && !url.password, 'public URL must not contain credentials');
  assert(!url.port || url.port === '443', 'public URL must use the default HTTPS port');
  assert(!hostname.endsWith('.local') && hostname !== 'localhost', 'public URL must not target a local hostname');
  assert(!isPrivateIpv4(hostname), 'public URL must not target a private address');
  assert(!isIpv4Literal(hostname) && !hostname.includes(':'), 'public URL must use an approved DNS hostname');
  assert(approved.has(hostname), `public URL host is not allowlisted: ${hostname}`);
  return url.toString();
}

module.exports = { DEFAULT_ALLOWED_PUBLIC_HOSTS, validatePublicHttpsUrl };
