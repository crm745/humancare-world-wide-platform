// READ-ONLY inspection of how Bitrix24 stores the Documents field of Deal 21760, to learn the correct REST format for adding a file
// without losing the existing ones. Exactly TWO read requests, nothing else:
//   1. crm.item.fields  { entityTypeId: 2, useOriginalUfNames: "N" }   the field definitions (camelCase keys + each field's upperName)
//   2. crm.item.get     { entityTypeId: 2, id: 21760, useOriginalUfNames: "Y" }   the Deal and the field's current value (original UF_CRM_ names,
//                                                                      the spelling the existing integration uses)
// It reports: the field key in both spellings, its type and whether it is multiple, the Deal's identity (id, category, stage, Case
// reference), and the SHAPE of the field value (how many files, the kind of each id, the names of each entry's keys, the ids).
//
//   node scripts/bitrix-file-field-inspect.js           run the two reads and print the findings
//   node scripts/bitrix-file-field-inspect.js --plan    print what would be sent; NO request is made
//
// It never calls crm.item.update or crm.deal.update, never uploads or downloads a file (the file URLs in the answer are neither printed
// nor followed), never touches the database, never starts a worker, and never prints the webhook. The webhook comes from backend/.env.test
// (the E2E environment, in memory only); its host must equal the allowed portal or nothing is sent. It does not use or change the
// existing integration code.
const { applyIsolatedEnv } = require('./e2e-env');

const TARGET = Object.freeze({
  portalHost: 'b24-4orefh.bitrix24.in', dealId: 21760, entityTypeId: 2, caseReference: 'CASE-3206', categoryId: '38',
  fileField: 'UF_CRM_1794832401', referenceField: 'UF_CRM_1794548440549', expectedFileIds: ['65616'],
  timeoutMs: 15000,
});

// The two requests, and nothing else. `method` is the REST method name.
const REQUESTS = Object.freeze({
  fields: { method: 'crm.item.fields', payload: { entityTypeId: TARGET.entityTypeId, useOriginalUfNames: 'N' } },
  item: { method: 'crm.item.get', payload: { entityTypeId: TARGET.entityTypeId, id: TARGET.dealId, useOriginalUfNames: 'Y' } },
});

function parseArgs(argv) {
  const out = { plan: false };
  for (const arg of argv) {
    if (arg === '--plan') out.plan = true;
    else throw new Error(`Bitrix file-field inspection: unknown argument "${String(arg).slice(0, 30)}". Use [--plan].`);
  }
  return out;
}

// ---- the HTTP layer: the last check before a request leaves the machine --------------------------------------------------------
// Only the two read methods, only Deal entity type 2, only Deal 21760 for the get, one request of each kind.
function makeGuard(nativeFetch) {
  const state = { sent: { 'crm.item.fields': 0, 'crm.item.get': 0 }, refused: [] };
  const deny = (why) => { state.refused.push(why); throw new Error(`Guarded fetch: ${why}.`); };
  const guardedFetch = async (url, init) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return deny('unusable URL'); }
    if (parsed.hostname.toLowerCase() !== TARGET.portalHost) return deny('host is not the allowed portal');
    if (!init || init.method !== 'POST') return deny('POST only');
    const method = Object.keys(state.sent).find((m) => parsed.pathname.endsWith(`/${m}.json`));
    if (!method) return deny('only crm.item.fields and crm.item.get are allowed');
    let body;
    try { body = JSON.parse(init.body); } catch { return deny('unreadable body'); }
    if (!body || body.entityTypeId !== TARGET.entityTypeId) return deny('only entityTypeId 2 (Deal) is allowed');
    if (method === 'crm.item.get' && Number(body.id) !== TARGET.dealId) return deny('not Deal 21760');
    if (method === 'crm.item.fields' && body.id !== undefined) return deny('crm.item.fields takes no id');
    if (state.sent[method] >= 1) return deny(`only one ${method} request is allowed`);
    state.sent[method] += 1;
    return nativeFetch(url, { ...init, redirect: 'error' });
  };
  return { guardedFetch, state };
}

// A short, safe description of an error: no URL, capped.
const safeText = (value) => String(value == null ? '' : value).replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').trim().slice(0, 120);

async function call(guardedFetch, webhook, { method, payload }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TARGET.timeoutMs);
  let res;
  let text;
  try {
    res = await guardedFetch(`${webhook}${method}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    text = await res.text();
  } catch (err) {
    throw new Error(`${method}: request failed (${err && err.name === 'AbortError' ? 'timeout' : safeText(err && err.message)}).`);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (data && data.error) throw new Error(`${method}: Bitrix error ${safeText(data.error)}: ${safeText(data.error_description)}`);
  if (!res.ok || !data || typeof data !== 'object' || data.result == null) throw new Error(`${method}: unusable answer (HTTP ${res.status}).`);
  return data.result;
}

// ---- reading the answers (pure) ------------------------------------------------------------------------------------------------
const squash = (s) => String(s).replace(/_/g, '').toLowerCase();

// The Documents field in the crm.item.fields answer: found by its upperName, its key, or its key with the underscores ignored.
function analyzeFields(result) {
  const fields = result && typeof result === 'object' ? (result.fields && typeof result.fields === 'object' ? result.fields : result) : {};
  const wanted = squash(TARGET.fileField);
  for (const [key, def] of Object.entries(fields)) {
    if (!def || typeof def !== 'object') continue;
    if (squash(def.upperName || '') === wanted || squash(key) === wanted) {
      return {
        found: true, camelKey: key, upperName: def.upperName == null ? null : String(def.upperName), type: def.type == null ? null : String(def.type),
        isMultiple: def.isMultiple === true || def.isMultiple === 'Y' || def.isMultiple === 1, isReadOnly: def.isReadOnly === true, isRequired: def.isRequired === true,
        title: safeText(def.title || def.formLabel || ''),
      };
    }
  }
  return { found: false };
}

// The Deal in the crm.item.get answer, and the SHAPE of the field value. File URLs are never read out.
function analyzeItem(result) {
  const item = result && typeof result === 'object' ? (result.item && typeof result.item === 'object' ? result.item : result) : {};
  const keyOf = (name) => Object.keys(item).find((k) => k === name) || Object.keys(item).find((k) => squash(k) === squash(name)) || null;
  const fieldKey = keyOf(TARGET.fileField);
  const raw = fieldKey ? item[fieldKey] : undefined;
  const entries = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === false || raw === '' ? [] : null);
  const refKey = keyOf(TARGET.referenceField);
  return {
    id: item.id == null ? null : String(item.id),
    categoryId: item.categoryId == null ? null : String(item.categoryId),
    stageId: item.stageId == null ? null : String(item.stageId),
    title: safeText(item.title),
    reference: refKey ? safeText(item[refKey]) : null,
    fieldKeyReturned: fieldKey,
    valueIsArray: Array.isArray(raw),
    files: entries === null ? null : entries.map((entry) => (entry && typeof entry === 'object'
      ? { id: entry.id == null ? null : String(entry.id), idType: typeof entry.id, keys: Object.keys(entry).sort() }
      : { id: entry == null ? null : String(entry), idType: typeof entry, keys: [] })),
  };
}

// The findings, as pass / fail lines. Nothing here changes anything.
function evaluate(def, deal) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok, text });
  add(def.found, `the field ${TARGET.fileField} is in the crm.item.fields answer`);
  if (def.found) {
    add(def.type === 'file', `its type is "file" (got "${def.type}")`);
    add(def.isMultiple, 'it is a multiple field');
  }
  add(deal.id === String(TARGET.dealId), `the item is Deal ${TARGET.dealId}`);
  add(deal.categoryId === TARGET.categoryId, `category is ${TARGET.categoryId} (got ${deal.categoryId})`);
  add(deal.reference === TARGET.caseReference || deal.title === TARGET.caseReference, `the Deal carries ${TARGET.caseReference}`);
  add(deal.fieldKeyReturned !== null, `crm.item.get returned the field under its original name when useOriginalUfNames is "Y"`);
  add(deal.files !== null, 'the field value is a list');
  if (deal.files) {
    const ids = deal.files.map((f) => f.id);
    add(JSON.stringify(ids) === JSON.stringify(TARGET.expectedFileIds), `the existing file ids are exactly [${TARGET.expectedFileIds.join(', ')}] (got [${ids.join(', ')}])`);
  }
  return checks;
}

function describePlan() {
  return [
    `1. ${REQUESTS.fields.method} ${JSON.stringify(REQUESTS.fields.payload)}`,
    `2. ${REQUESTS.item.method} ${JSON.stringify(REQUESTS.item.payload)}`,
    `host ${TARGET.portalHost} only; no update, upload or download; the webhook is never printed.`,
  ];
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.plan) {
    console.log('Bitrix file-field inspection: PLAN (no request is made).');
    for (const line of describePlan()) console.log(`  ${line}`);
    return;
  }

  const env = applyIsolatedEnv(); // the E2E environment (.env.test), in memory only; it does not connect to any database
  const webhook = env.BITRIX24_WEBHOOK_URL;
  let host = null;
  try { host = new URL(String(webhook)).hostname.toLowerCase(); } catch { host = null; }
  if (host !== TARGET.portalHost) throw new Error('Bitrix file-field inspection: the webhook host in .env.test is not the allowed portal. Nothing was sent.');
  console.log(`Bitrix file-field inspection: portal ${TARGET.portalHost}, Deal ${TARGET.dealId}; two read requests.`);

  const { guardedFetch, state } = makeGuard(globalThis.fetch);
  const fieldsResult = await call(guardedFetch, webhook, REQUESTS.fields);
  const def = analyzeFields(fieldsResult);
  const itemResult = await call(guardedFetch, webhook, REQUESTS.item);
  const deal = analyzeItem(itemResult);

  console.log('Field definition (crm.item.fields, camelCase mode):');
  console.log(def.found
    ? `  camelCase key ${def.camelKey}; upperName ${def.upperName}; type ${def.type}; multiple ${def.isMultiple}; required ${def.isRequired}; read-only ${def.isReadOnly}; label "${def.title}"`
    : `  ${TARGET.fileField} was not found among ${Object.keys((fieldsResult && fieldsResult.fields) || fieldsResult || {}).length} fields.`);
  console.log('Deal (crm.item.get, original-name mode):');
  console.log(`  id ${deal.id}; category ${deal.categoryId}; stage ${deal.stageId}; title ${deal.title}; Case reference ${deal.reference}`);
  console.log(`  field returned as "${deal.fieldKeyReturned}"; value is ${deal.valueIsArray ? 'a list' : 'not a list'}; ${deal.files ? deal.files.length : '?'} file(s):`);
  for (const f of deal.files || []) console.log(`    id ${f.id} (${f.idType}); entry keys: ${f.keys.join(', ') || 'none'}`);

  const checks = evaluate(def, deal);
  console.log('Checks:');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.text}`);
  console.log(`Requests sent: crm.item.fields ${state.sent['crm.item.fields']}, crm.item.get ${state.sent['crm.item.get']}; refused: ${state.refused.join(', ') || 'none'}. Nothing was changed.`);
  if (checks.some((c) => !c.ok)) process.exitCode = 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(safeText(err && err.message));
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, makeGuard, analyzeFields, analyzeItem, evaluate, describePlan, REQUESTS, TARGET };
