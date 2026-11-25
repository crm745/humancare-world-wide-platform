// How Express learns the real client IP behind a reverse proxy / load balancer. Pure, so it can be unit-tested.
//
// The rate limiters (and the logs) key on req.ip. With no proxy setting Express uses the socket address: correct for a server that faces the internet directly, WRONG behind a proxy (everyone shares
// the proxy's address). Trusting X-Forwarded-For blindly is worse (any client can claim any address and dodge a limiter). So the setting is explicit and strict:
//   TRUST_PROXY unset, "", "false", "0"   do not trust any proxy (the default: the socket address is used)
//   TRUST_PROXY=<N>                       trust exactly N proxy hops in front of the app (1 = one load balancer / nginx); 1 to 10
//   TRUST_PROXY=loopback | linklocal | uniquelocal | a comma-separated list of those names, IPs or CIDRs (e.g. "10.0.0.0/8,172.16.0.0/12")   trust only those proxies
//   TRUST_PROXY=true                      REFUSED: it trusts every address and lets a client forge X-Forwarded-For
// A wrong value stops the server at start with a clear message instead of silently weakening the limiters.
const NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;

function validEntry(entry) {
  if (NAMES.has(entry)) return true;
  if (IPV4.test(entry)) {
    const [address, bits] = entry.split('/');
    if (address.split('.').some((n) => Number(n) > 255)) return false;
    return bits === undefined || Number(bits) <= 32;
  }
  if (IPV6.test(entry) && entry.includes(':')) {
    const [, bits] = entry.split('/');
    return bits === undefined || Number(bits) <= 128;
  }
  return false;
}

// -> false | a number | an array of names / addresses (what `app.set('trust proxy', value)` takes). Throws on a value that is not safe or not understood.
function resolveTrustProxy(env = process.env) {
  const raw = String(env.TRUST_PROXY === undefined ? '' : env.TRUST_PROXY).trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true') throw new Error('TRUST_PROXY=true trusts every address and lets any client forge X-Forwarded-For. Set the number of proxy hops (for example TRUST_PROXY=1) or the proxy addresses.');
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops < 1 || hops > 10) throw new Error('TRUST_PROXY must be between 1 and 10 hops.');
    return hops;
  }
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0 || !entries.every(validEntry)) throw new Error('TRUST_PROXY must be a number of hops, "loopback", "linklocal", "uniquelocal", or a comma-separated list of IP addresses / CIDRs.');
  return entries;
}

module.exports = { resolveTrustProxy };
