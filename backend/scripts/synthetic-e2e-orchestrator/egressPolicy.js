// Pure egress policy for the synthetic E2E run: decides whether a destination (host name or IP address) may be
// contacted. No I/O, no network, no globals - it is shared by the in-process guard (egressGuard.js), the browser
// proxy (egressProxy.js) and the orchestrator, and is unit-tested on its own.
//
// What is blocked: the Bitrix24 portal. By name (the configured webhook host, plus ANY host whose labels look like a
// Bitrix24 cloud portal) and by address (the IPs the webhook host resolved to when the run started, in every numeric
// spelling the platform's resolver accepts). Everything else - loopback services, Firebase, Google - stays reachable.
//
// The classification NEVER consults the network. A DNS answer that later turns out to be a blocked address is
// caught by the guard, which re-checks every address a lookup returns (see egressGuard.js).
const net = require('net');

// A name that is ALWAYS blocked and resolves nowhere, used by the self-tests as a canary for "the policy is active".
const CANARY_HOST = 'egress-canary.bitrix24.invalid';
// TEST-NET-1 (RFC 5737): reserved for documentation, never routable. Always blocked; the self-test's known-blocked ADDRESS.
const CANARY_IP = '192.0.2.1';

// Bitrix24 cloud portals are <name>.bitrix24.<tld> (bitrix24.in, bitrix24.com, bitrix24.eu, bitrix24.net, ...), and
// Bitrix's own domains. The pattern is a label match, not a substring match, so "notbitrix24.example" is not caught.
const BITRIX_NAME_PATTERN = /(^|\.)(bitrix24|bitrix)(\.[a-z0-9-]+)+$/i;

// ---- host name normalisation ----------------------------------------------------------------------------------------
// Lower-case, strip IPv6 brackets, strip ONE trailing dot ("host." is the same name), strip an IPv6 zone id.
function normalizeHost(value) {
  if (typeof value !== 'string') return '';
  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone > 0 && host.includes(':')) host = host.slice(0, zone);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

// ---- IP canonicalisation --------------------------------------------------------------------------------------------
// The platform resolver (inet_aton) accepts spellings net.isIP() does not: "0x34.0x42.0x6d.0x95", "0x34426d95",
// "878931349" (one decimal number), "0420.66.109.148" (octal) and short forms such as "127.1". A connection made to
// such a string reaches the same address, so each one is converted to dotted-quad before it is compared.
function parseInetAtonPart(text) {
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text, 16);
  if (/^0[0-7]+$/.test(text)) return parseInt(text, 8);
  if (/^(0|[1-9][0-9]*)$/.test(text)) return parseInt(text, 10);
  return null;
}

function inetAtonToDotted(text) {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const numbers = parts.map(parseInetAtonPart);
  if (numbers.some((n) => n === null || !Number.isFinite(n) || n < 0)) return null;
  const last = numbers[numbers.length - 1];
  const leading = numbers.slice(0, -1);
  if (leading.some((n) => n > 255)) return null;
  const lastMax = 2 ** (8 * (5 - parts.length)) - 1; // 1 part: 2^32-1; 2 parts: 2^24-1; 3 parts: 2^16-1; 4 parts: 255
  if (last > lastMax) return null;
  let value = last;
  leading.forEach((n, i) => { value += n * 2 ** (8 * (3 - i)); });
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

// IPv6 (possibly IPv4-mapped / IPv4-compatible) -> the embedded dotted-quad, else null.
function embeddedIpv4(ipv6) {
  const lower = ipv6.toLowerCase();
  const dotted = /^(?:::ffff:|::|0:0:0:0:0:ffff:|0:0:0:0:0:0:)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

// A canonical address string (dotted-quad IPv4, or lower-case IPv6), or null when `value` is not an address.
function canonicalIp(value) {
  const host = normalizeHost(value);
  if (!host) return null;
  const family = net.isIP(host);
  if (family === 4) return host;
  if (family === 6) return embeddedIpv4(host) || host;
  // Not a plain address: is it an inet_aton spelling of one? A real host name always contains a letter that is not a hex
  // digit or an "x", so "example.com" falls out here, while "0x34426d95" and "878931349" convert.
  return inetAtonToDotted(host);
}

// ---- the policy ---------------------------------------------------------------------------------------------------
// options: { blockedHosts: string[] (exact names), blockedIps: string[] (addresses, any spelling), extraPatterns: RegExp[] }
function createPolicy({ blockedHosts = [], blockedIps = [], extraPatterns = [] } = {}) {
  const hosts = new Set(blockedHosts.map(normalizeHost).filter(Boolean));
  hosts.add(CANARY_HOST);
  const ips = new Set(blockedIps.map(canonicalIp).filter(Boolean));
  ips.add(CANARY_IP);
  const patterns = [BITRIX_NAME_PATTERN, ...extraPatterns];

  function checkName(name) {
    const host = normalizeHost(name);
    if (!host) return { blocked: false };
    if (hosts.has(host)) return { blocked: true, reason: 'blocked_host' };
    if (patterns.some((p) => p.test(host))) return { blocked: true, reason: 'bitrix_name_pattern' };
    return { blocked: false };
  }

  function checkIp(address) {
    const ip = canonicalIp(address);
    if (ip && ips.has(ip)) return { blocked: true, reason: 'blocked_ip' };
    return { blocked: false };
  }

  // A destination of unknown kind: an address is checked as an address (every spelling), anything else as a name.
  function check(destination) {
    const ip = canonicalIp(destination);
    if (ip) return { ...checkIp(ip), kind: 'ip' };
    return { ...checkName(destination), kind: 'name' };
  }

  return {
    check, checkName, checkIp,
    isBlocked: (destination) => check(destination).blocked,
    describe: () => ({ hostCount: hosts.size, ipCount: ips.size }),
    snapshot: () => ({ blockedHosts: [...hosts], blockedIps: [...ips] }),
  };
}

// The policy travels to child processes through two environment variables (JSON), never through argv.
const ENV_HOSTS = 'HC_EGRESS_BLOCK_HOSTS';
const ENV_IPS = 'HC_EGRESS_BLOCK_IPS';

function policyToEnv(policy) {
  const { blockedHosts, blockedIps } = policy.snapshot();
  return { [ENV_HOSTS]: JSON.stringify(blockedHosts), [ENV_IPS]: JSON.stringify(blockedIps) };
}

function parseList(text) {
  try {
    const parsed = JSON.parse(text || '[]');
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return null; // unreadable: the caller must fail closed
  }
}

// Returns a policy, or throws when the environment's policy cannot be read (a guard must never start with no policy).
function policyFromEnv(env = process.env) {
  const hosts = parseList(env[ENV_HOSTS]);
  const ips = parseList(env[ENV_IPS]);
  if (hosts === null || ips === null) throw new Error('the egress policy in the environment is unreadable');
  return createPolicy({ blockedHosts: hosts, blockedIps: ips });
}

module.exports = {
  CANARY_HOST, CANARY_IP, BITRIX_NAME_PATTERN, ENV_HOSTS, ENV_IPS,
  normalizeHost, canonicalIp, inetAtonToDotted, createPolicy, policyToEnv, policyFromEnv,
};
