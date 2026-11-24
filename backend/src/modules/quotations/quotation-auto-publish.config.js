// Configuration of the quotation AUTO-PUBLISH sweep (quotation-auto-publish.service.js). Everything is read from the environment at call time
// (never at import) and nothing is trimmed, lower-cased or repaired: a wrong value is reported as a short code, never fixed. Every switch is OFF by
// default, and the configuration fails CLOSED: any problem means the sweep does nothing.
//
//   QUOTATION_AUTO_PUBLISH                  exactly "true" turns the sweep on
//   QUOTATION_AUTO_PUBLISH_FROM             ISO 8601 UTC time (the one explicit cutoff): a quotation created BEFORE it is never touched
//   QUOTATION_AUTO_PUBLISH_ADMIN_ID         the existing Admin the sweep acts as (a positive integer). Its account is re-verified on EVERY sweep
//   QUOTATION_AUTO_PUBLISH_SETTLE_SECONDS   optional; how long a clean version must stay unchanged first. Default and minimum 120 (never lower)
// It also needs the quotation synchronization to be active (BITRIX_QUOTATION_SYNC_ENABLED and the Bitrix switches), BITRIX_DEAL_PROFILE=actual
// (Category 0), and it only ever runs against the local development database: it refuses under NODE_ENV=production, and unless DATABASE_URL names
// humancare_dev on a loopback host (the sweep also asks the database server itself, see the service).
const { isQuotationSyncActive } = require('../bitrix/bitrix-config');
const { resolveProfile, PROFILE_ACTUAL } = require('../bitrix/bitrix-profiles');
const { quotationFieldsForProfile } = require('../bitrix/quotation-outbox');

// The Bitrix Category 0 stage the Deal must be in ("Quoted"). Fixed here on purpose: it is not configurable.
const REQUIRED_STAGE_ID = 'UC_R55CKV';
const REQUIRED_DATABASE = 'humancare_dev';
const MIN_SETTLE_SECONDS = 120;
const MAX_SETTLE_SECONDS = 86400;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const isRequested = (env = process.env) => env.QUOTATION_AUTO_PUBLISH === 'true';

function databaseProblem(env) {
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { return 'database_url_invalid'; }
  if (url.protocol !== 'mysql:') return 'database_url_invalid';
  if (!LOOPBACK_HOSTS.has(url.hostname)) return 'database_host_not_local';
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== REQUIRED_DATABASE) return 'database_not_humancare_dev';
  return null;
}

/** The validated settings, or { problem } with a short code. Never contains a value. `switch_off` = not requested (the normal, quiet state). */
function readSettings(env = process.env) {
  if (!isRequested(env)) return { problem: 'switch_off' };
  if (env.NODE_ENV === 'production') return { problem: 'refused_in_production' };
  const from = env.QUOTATION_AUTO_PUBLISH_FROM;
  if (typeof from !== 'string' || !ISO_UTC.test(from) || Number.isNaN(Date.parse(from))) return { problem: 'cutoff_missing_or_invalid' };
  const adminText = env.QUOTATION_AUTO_PUBLISH_ADMIN_ID;
  if (typeof adminText !== 'string' || !/^[1-9]\d{0,9}$/.test(adminText)) return { problem: 'admin_id_missing_or_invalid' };
  let settleSeconds = MIN_SETTLE_SECONDS;
  if (env.QUOTATION_AUTO_PUBLISH_SETTLE_SECONDS !== undefined && env.QUOTATION_AUTO_PUBLISH_SETTLE_SECONDS !== '') {
    const text = env.QUOTATION_AUTO_PUBLISH_SETTLE_SECONDS;
    if (typeof text !== 'string' || !/^[1-9]\d{0,5}$/.test(text)) return { problem: 'settle_invalid' };
    settleSeconds = Number(text);
    if (settleSeconds < MIN_SETTLE_SECONDS || settleSeconds > MAX_SETTLE_SECONDS) return { problem: 'settle_invalid' };
  }
  const dbProblem = databaseProblem(env);
  if (dbProblem) return { problem: dbProblem };
  const profile = resolveProfile(env);
  if (!profile || profile.name !== PROFILE_ACTUAL || String(profile.categoryId) !== '0') return { problem: 'profile_not_actual' };
  if (!quotationFieldsForProfile(profile)) return { problem: 'quotation_fields_not_configured' };
  if (!isQuotationSyncActive(env)) return { problem: 'quotation_sync_inactive' };
  return { settings: { from: new Date(from), adminId: Number(adminText), settleSeconds, profile } };
}

module.exports = { readSettings, isRequested, REQUIRED_STAGE_ID, REQUIRED_DATABASE, MIN_SETTLE_SECONDS, MAX_SETTLE_SECONDS };
