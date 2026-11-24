/* global describe, test, expect, jest, beforeEach */
// How the quotation sync is wired into what already exists: the switch, the jobs, the inbound Deal processor (and through it the
// reconciliation job), the signature of a Deal, the scoped runner and the things this feature must never do.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() }));

const fs = require('fs');
const path = require('path');
const cfg = require('../../src/modules/bitrix/bitrix-config');
const inbox = require('../../src/modules/bitrix/deal-inbox.service');
const { readQuotationSignature, sameAsHead, quotationSyncKey, QUOTATION_FIELD, QUOTATION_SYNC_EVENT, QUOTATION_ENTITY_TYPE } = require('../../src/modules/bitrix/quotation-outbox');
const { parseQuotationMoney } = require('../../src/modules/bitrix/quotation-money');
const kit = require('./quotation-test-kit');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const NEW_SOURCES = [
  'src/modules/bitrix/quotation-money.js', 'src/modules/bitrix/quotation-versioning.js', 'src/modules/bitrix/quotation-storage.js', 'src/modules/bitrix/quotation-outbox.js',
  'src/modules/bitrix/quotation-sync.store.js', 'src/modules/bitrix/quotation-sync.service.js', 'src/modules/bitrix/quotation-scan.service.js',
  'src/jobs/bitrix-quotation.job.js', 'src/jobs/scan-case-quotations.job.js',
];
const code = (rel) => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

describe('the third switch', () => {
  test('is OFF unless it says exactly "true"', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true']) expect(cfg.isQuotationSyncRequested({ BITRIX_QUOTATION_SYNC_ENABLED: value })).toBe(false);
    expect(cfg.isQuotationSyncRequested({ BITRIX_QUOTATION_SYNC_ENABLED: 'true' })).toBe(true);
    expect(cfg.isQuotationSyncRequested({})).toBe(false);
  });
  test('is active only together with both Bitrix switches and the review workflow', () => {
    const all = { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true' };
    expect(cfg.isQuotationSyncActive(all)).toBe(true);
    for (const missing of Object.keys(all)) expect(cfg.isQuotationSyncActive({ ...all, [missing]: 'false' })).toBe(false);
  });
  test('an impossible combination refuses to start; the existing combinations are unchanged', () => {
    expect(cfg.bitrixConfigurationProblems({ BITRIX_QUOTATION_SYNC_ENABLED: 'true' }).join(' ')).toMatch(/BITRIX_QUOTATION_SYNC_ENABLED=true needs/);
    expect(cfg.bitrixConfigurationProblems({})).toEqual([]);
    expect(cfg.bitrixConfigurationProblems({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true' })).toEqual([]);
  });
  test('the example environment file documents it, OFF', () => {
    expect(read('.env.test.example')).toMatch(/^BITRIX_QUOTATION_SYNC_ENABLED="false"$/m);
  });
});

describe('the jobs', () => {
  const { jobs } = require('../../src/jobs');
  beforeEach(() => { for (const key of ['BITRIX_QUOTATION_SYNC_ENABLED', 'BITRIX_SYNC_ENABLED', 'BITRIX_PRIVATE_CHARTER_DEAL_ENABLED', 'PRIVATE_CHARTER_REVIEW_WORKFLOW']) delete process.env[key]; });

  test('are registered exactly once, with distinct names, and not run at start', () => {
    expect(jobs.filter((j) => j.name === 'bitrix-quotation')).toHaveLength(1);
    expect(jobs.filter((j) => j.name === 'scan-case-quotations')).toHaveLength(1);
    expect(jobs.find((j) => j.name === 'bitrix-quotation')).toMatchObject({ intervalMs: 30 * 1000, runOnStart: false });
    expect(jobs.find((j) => j.name === 'scan-case-quotations')).toMatchObject({ intervalMs: 60 * 1000, runOnStart: false });
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
  });
  test('the existing jobs are all still registered', () => {
    for (const name of ['bitrix-retry', 'bitrix-deal', 'bitrix-deal-inbox', 'bitrix-deal-reconcile', 'bitrix-deal-document', 'scan-request-documents', 'payment-order-recovery', 'razorpay-webhook-inbox']) {
      expect(jobs.some((j) => j.name === name)).toBe(true);
    }
  });
  test('are idle while the switch is off: they touch neither the database (a mock that throws on use) nor Bitrix', async () => {
    expect(await jobs.find((j) => j.name === 'bitrix-quotation').run()).toEqual({ active: false, claimed: 0 });
    expect(await jobs.find((j) => j.name === 'scan-case-quotations').run()).toEqual({ active: false, checked: 0 });
  });
});

describe('the inbound Deal processor (which the reconciliation job also feeds)', () => {
  const REQUEST = { id: 4672, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null };
  const CASE = { id: 3037, referenceNumber: kit.REF, serviceRequestId: 4672, status: 'in_progress', serviceRequest: REQUEST };
  const unknownStageDeal = { ...kit.dealBody(), STAGE_ID: 'C38:NOT_A_STAGE' }; // quarantined AFTER the quotation check: proves it is stage-independent

  function setup(env, { enqueueError = null } = {}) {
    const tx = { auditLog: { create: jest.fn(async () => ({})) } };
    const prisma = {
      bitrixDealLink: { findUnique: jest.fn(async () => ({ id: 1173, caseId: 3037, bitrixDealId: kit.DEAL, case: CASE })) },
      caseQuotation: { findFirst: jest.fn(async () => null) },
      integrationOutbox: { create: jest.fn(async () => { if (enqueueError) throw enqueueError; return {}; }) },
      $transaction: jest.fn(async (fn) => fn(tx)),
    };
    const store = { writeResult: jest.fn(async () => 1) };
    const log = { error: jest.fn(), warn: jest.fn() };
    const api = { getDeal: jest.fn(async () => ({ status: 'ok', deal: unknownStageDeal })) };
    return { prisma, store, log, api, ctx: { prisma, store, api, env, log, push: jest.fn(), lostReasonField: 'UF_LOST', workerId: 'w' } };
  }
  const claim = { id: 1, dealId: kit.DEAL, attempts: 1 };

  test('with the switch ON it queues ONE quotation event for a Deal that carries a quotation the database does not have', async () => {
    const s = setup(kit.ENV_ON);
    await inbox.processInboxEvent(s.ctx, claim);
    expect(s.prisma.integrationOutbox.create).toHaveBeenCalledTimes(1);
    expect(s.prisma.integrationOutbox.create.mock.calls[0][0].data).toMatchObject({ eventType: QUOTATION_SYNC_EVENT, entityType: QUOTATION_ENTITY_TYPE, entityId: kit.DEAL, caseId: 3037, status: 'pending', payload: { caseId: 3037, dealId: kit.DEAL, fileId: '65834' } });
    expect(JSON.stringify(s.prisma.integrationOutbox.create.mock.calls[0][0].data.payload)).not.toMatch(/url|token|name|amount/i); // identifiers only
    expect(s.store.writeResult).toHaveBeenCalledWith(expect.anything(), claim, expect.objectContaining({ status: 'ignored' })); // the stage handling still ran (quarantine)
  });

  test('with the switch OFF it neither reads quotations nor writes an event: the processor behaves exactly as before', async () => {
    const { BITRIX_QUOTATION_SYNC_ENABLED: _off, ...without } = kit.ENV_ON;
    const s = setup(without);
    await inbox.processInboxEvent(s.ctx, claim);
    expect(s.prisma.caseQuotation.findFirst).not.toHaveBeenCalled();
    expect(s.prisma.integrationOutbox.create).not.toHaveBeenCalled();
    expect(s.store.writeResult).toHaveBeenCalledWith(expect.anything(), claim, expect.objectContaining({ status: 'ignored' }));
  });

  test('an already-queued observation (unique key) is not an error and not a duplicate', async () => {
    const s = setup(kit.ENV_ON, { enqueueError: Object.assign(new Error('unique'), { code: 'P2002' }) });
    await inbox.processInboxEvent(s.ctx, claim);
    expect(s.store.writeResult).toHaveBeenCalledWith(expect.anything(), claim, expect.objectContaining({ status: 'ignored' }));
  });

  test('if the event cannot be recorded the whole inbox event is retried (a lost trigger would not come back by itself)', async () => {
    const s = setup(kit.ENV_ON, { enqueueError: new Error('database down') });
    await inbox.processInboxEvent(s.ctx, claim);
    expect(s.store.writeResult).toHaveBeenCalledWith(expect.anything(), claim, expect.objectContaining({ status: 'received', lastError: 'quotation_enqueue_failed' }));
  });

  test('the hook sits after the Deal is verified and before the stage is looked up; reconciliation is unchanged and still feeds this processor', () => {
    const source = read('src/modules/bitrix/deal-inbox.service.js');
    const at = (text) => source.indexOf(text);
    // The Deal is verified against the ACTIVE PROFILE (category and the profile's reference field) before the hook, which gets that profile.
    const verified = "dealProblem(active, deal, claim.dealId, caseRecord.referenceNumber)";
    expect(at(verified)).toBeGreaterThan(-1);
    expect(at('detectAndEnqueueQuotationSync(ctx.prisma')).toBeGreaterThan(at(verified));
    expect(source).toContain('detectAndEnqueueQuotationSync(ctx.prisma, caseRecord, deal, active)');
    expect(at('detectAndEnqueueQuotationSync(ctx.prisma')).toBeLessThan(at('lookupProfileStage(active, deal.STAGE_ID'));
    expect(source).toMatch(/if \(isQuotationSyncActive\(ctx\.env\)\)/);
    const reconcile = read('src/modules/bitrix/deal-reconcile.service.js');
    expect(reconcile).toContain("eventType: 'ONCRMDEALUPDATE'");
    expect(reconcile).not.toMatch(/quotation/i);
  });
});

describe('the Bitrix quotation field IDs (verified read-only against Deal 21802: the amount field has TWO trailing Fs)', () => {
  test('the three exact field codes are pinned', () => {
    expect(QUOTATION_FIELD).toEqual({ FILE: 'UF_CRM_1794985313', AMOUNT: 'UF_CRM_6A3399F56ECFF', CURRENCY: 'UF_CRM_6A23F4E86AA45' });
    expect(Object.isFrozen(QUOTATION_FIELD)).toBe(true);
  });
  test('the test fixtures use the same codes, so a wrong code in the source cannot be hidden by a matching wrong fake', () => {
    expect(kit.FILE_FIELD).toBe('UF_CRM_1794985313');
    expect(kit.AMOUNT_FIELD).toBe('UF_CRM_6A3399F56ECFF');
    expect(kit.CURRENCY_FIELD).toBe('UF_CRM_6A23F4E86AA45');
  });
  test('the old one-F code is not read: a Deal that only has it carries no amount', () => {
    expect(readQuotationSignature({ UF_CRM_1794985313: { id: 65834 }, UF_CRM_6A3399F56ECF: '1000', UF_CRM_6A23F4E86AA45: 'INR' })).toEqual({ fileId: '65834', amountRaw: null, currencyRaw: 'INR' });
  });
  test('crm.deal.get returns the amount as the string "1000": it reads and parses to 1000.00 INR', () => {
    const deal = { UF_CRM_1794985313: { id: 65834, showUrl: '/x', downloadUrl: '/y' }, UF_CRM_6A3399F56ECFF: '1000', UF_CRM_6A23F4E86AA45: 'INR' };
    const signature = readQuotationSignature(deal);
    expect(signature).toEqual({ fileId: '65834', amountRaw: '1000', currencyRaw: 'INR' });
    expect(parseQuotationMoney(signature.amountRaw, signature.currencyRaw)).toMatchObject({ amount: '1000.00', currency: 'INR', error: null });
  });
  test('crm.item.get returns the amount as the number 1000: it reads and parses to 1000.00 INR', () => {
    const item = { UF_CRM_1794985313: { id: 65834, url: '/x', urlMachine: '/y' }, UF_CRM_6A3399F56ECFF: 1000, UF_CRM_6A23F4E86AA45: 'INR' };
    const signature = readQuotationSignature(item);
    expect(signature).toEqual({ fileId: '65834', amountRaw: '1000', currencyRaw: 'INR' });
    expect(parseQuotationMoney(signature.amountRaw, signature.currencyRaw)).toMatchObject({ amount: '1000.00', currency: 'INR', error: null });
  });
  test('the string and the number give exactly the same observation (so one cannot be mistaken for a change of the other)', () => {
    const fromDeal = readQuotationSignature({ UF_CRM_6A3399F56ECFF: '1000', UF_CRM_6A23F4E86AA45: 'INR' });
    const fromItem = readQuotationSignature({ UF_CRM_6A3399F56ECFF: 1000, UF_CRM_6A23F4E86AA45: 'INR' });
    expect({ ...fromDeal, fileId: 'x' }).toEqual({ ...fromItem, fileId: 'x' });
  });
  test('a "1000.00000" style double and an empty field are handled too', () => {
    expect(parseQuotationMoney(readQuotationSignature({ UF_CRM_6A3399F56ECFF: '1000.00000', UF_CRM_6A23F4E86AA45: 'INR' }).amountRaw, 'INR')).toMatchObject({ amount: '1000.00', currency: 'INR' });
    expect(readQuotationSignature({ UF_CRM_6A3399F56ECFF: '', UF_CRM_6A23F4E86AA45: 'INR' }).amountRaw).toBeNull();
  });
});

describe('the signature of a Deal', () => {
  test('is read from crm.deal.get: the file field is an object {id,...}; an empty amount is a missing key, an empty currency is ""', () => {
    expect(readQuotationSignature(kit.dealBody())).toEqual({ fileId: '65834', amountRaw: null, currencyRaw: null });
    expect(readQuotationSignature(kit.dealBody({ amount: ' 1500.00 ', currency: 'INR' }))).toEqual({ fileId: '65834', amountRaw: '1500.00', currencyRaw: 'INR' });
    expect(readQuotationSignature(kit.dealBody({ fileId: null })).fileId).toBe('none');
    expect(readQuotationSignature({ UF_CRM_1794985313: [] }).fileId).toBe('none');
    expect(readQuotationSignature({ UF_CRM_1794985313: 65834 }).fileId).toBe('65834');
    for (const bad of [{ id: 'abc' }, { id: 0 }, { id: -1 }, 'abc', [1, 2], true]) expect(readQuotationSignature({ UF_CRM_1794985313: bad }).fileId).toBe('invalid');
  });
  test('sameAsHead compares the file id and the RAW amount and currency exactly', () => {
    const head = { bitrixFileId: '65834', bitrixAmountRaw: '10', bitrixCurrencyRaw: 'INR' };
    expect(sameAsHead({ fileId: '65834', amountRaw: '10', currencyRaw: 'INR' }, head)).toBe(true);
    expect(sameAsHead({ fileId: '65835', amountRaw: '10', currencyRaw: 'INR' }, head)).toBe(false);
    expect(sameAsHead({ fileId: '65834', amountRaw: '10.0', currencyRaw: 'INR' }, head)).toBe(false);
    expect(sameAsHead({ fileId: 'none', amountRaw: null, currencyRaw: null }, null)).toBe(true);
    expect(sameAsHead({ fileId: '65834', amountRaw: null, currencyRaw: null }, null)).toBe(false);
  });
  test('the idempotency key differs by Case, head version, file and money, and stays within the column', () => {
    const sig = { fileId: '65834', amountRaw: null, currencyRaw: null };
    const keys = new Set([quotationSyncKey(1, 0, sig), quotationSyncKey(2, 0, sig), quotationSyncKey(1, 1, sig), quotationSyncKey(1, 0, { ...sig, fileId: '9' }), quotationSyncKey(1, 0, { ...sig, amountRaw: '5' })]);
    expect(keys.size).toBe(5);
    expect(quotationSyncKey(3037, 0, sig)).toMatch(/^bitrix\.quotation\.sync:case:3037:v0:65834:[0-9a-f]{16}$/);
    expect(quotationSyncKey(3037, 0, sig).length).toBeLessThanOrEqual(191);
  });
});

describe('the scoped CASE-4037 runner', () => {
  const runner = require('../../scripts/e2e-quotation-sync');
  const HOST = runner.TARGET.portalHost;

  test('is pinned to Case 3037 / CASE-4037 / REQ-5672 / Deal 21802 / category 38 / humancare_test', () => {
    expect(runner.TARGET).toMatchObject({ caseId: 3037, caseReference: 'CASE-4037', requestId: 4672, requestReference: 'REQ-5672', dealId: '21802', category: '38', dbName: 'humancare_test', dbUser: 'humancare_test_app', portalHost: 'b24-4orefh.bitrix24.in' });
  });
  test('defaults to a dry run; a write needs BOTH --execute and --confirm CASE-4037; nothing else is accepted', () => {
    expect(runner.parseArgs([])).toEqual({ execute: false, confirmed: false, detectOnly: false, scanOnly: false });
    expect(runner.parseArgs(['--detect-only']).detectOnly).toBe(true);
    expect(runner.parseArgs(['--execute', '--confirm', 'CASE-4037'])).toEqual({ execute: true, confirmed: true, detectOnly: false, scanOnly: false });
    for (const bad of [['--execute'], ['--confirm', 'CASE-4037'], ['--execute', '--confirm', 'CASE-3206'], ['--execute', '--confirm'], ['--execute', '--confirm', 'CASE-4037', '--detect-only'], ['--case-ids', '3203'], ['--live']]) {
      expect(() => runner.parseArgs(bad)).toThrow(/Quotation sync run/);
    }
  });
  describe('--scan-only (the ClamAV scan of quotation 762 and nothing else)', () => {
    const source = code('scripts/e2e-quotation-sync.js');
    const scanOnlySource = source.slice(source.indexOf('async function runScanOnly'), source.indexOf('async function main(argv)'));

    test('is pinned to quotation 762, version 1, 1000 INR and its exact stored file', () => {
      expect(runner.TARGET).toMatchObject({
        quotationId: 762, quotationVersion: 1, quotationAmount: '1000', quotationCurrency: 'INR',
        quotationSha256: '279f139a63c1942fa8b945d87f44d942e8f4a72ca864af7102f22f9ffb64cd6c',
        quotationStorageKey: 'quotations/case-3037/ev466-279f139a63c1942fa8b945d87f44d942e8f4a72ca864af7102f22f9ffb64cd6c.pdf',
      });
    });
    test('needs --confirm CASE-4037 and cannot be combined with --execute or --detect-only', () => {
      expect(runner.parseArgs(['--scan-only', '--confirm', 'CASE-4037'])).toEqual({ execute: false, confirmed: true, detectOnly: false, scanOnly: true });
      for (const bad of [['--scan-only'], ['--scan-only', '--confirm', 'CASE-3206'], ['--scan-only', '--execute', '--confirm', 'CASE-4037'], ['--scan-only', '--detect-only', '--confirm', 'CASE-4037'], ['--scan-only', '--case-ids', '3203', '--confirm', 'CASE-4037'], ['--scan-only', '--quotation-id', '1', '--confirm', 'CASE-4037']]) {
        expect(() => runner.parseArgs(bad)).toThrow(/Quotation sync run/);
      }
    });
    test('makes ZERO Bitrix calls: it never uses the Bitrix client, detection, the sync worker or the network guard, and blanks the webhook', () => {
      expect(scanOnlySource.length).toBeGreaterThan(500);
      expect(scanOnlySource).not.toMatch(/realApi|makeGuard|makeGuardedApi|detectAndEnqueue|runQuotationSync|readQuotationSignature|getDeal|getDealFileField|downloadBitrixFile|createDeal|updateDealFiles/);
      expect(scanOnlySource).toContain('workerEnv(env, { live: false })'); // live: false blanks BITRIX24_WEBHOOK_URL and the inbound token
      expect(scanOnlySource).toContain('global.fetch = () =>'); // and fetch itself is replaced by a function that counts and refuses
      expect(scanOnlySource).toContain('net.fetchCalls !== 0');
    });
    test('scans only Case 3037 and only quotation 762, and compares every other quotation and outbox row before and after', () => {
      expect(scanOnlySource).toContain('caseIds: [TARGET.caseId], quotationIds: [TARGET.quotationId]');
      expect(scanOnlySource).toMatch(/exactly one quotation, 762/);
      expect(scanOnlySource).toContain('othersUnchanged');
      expect(scanOnlySource).toContain('outboxUnchanged');
      expect(scanOnlySource).toMatch(/verifyLiveDatabase\(prisma\);\s*\n\s*const quotesBefore/); // the database is verified again right before the pass
    });
    test('verifies the quotation state and the file hash BEFORE scanning, and writes nothing itself (the scan service does the one result write)', () => {
      const beforeScan = scanOnlySource.slice(0, scanOnlySource.indexOf('sweepPendingQuotationScans({'));
      for (const needle of ['hashFile(storage.pathOf', "q.status !== 'draft'", 'confirmed_at != null', 'published_at != null', "scan_status !== 'pending'", 'a scan lease is still active', 'q.sha256 !== TARGET.quotationSha256']) expect(beforeScan).toContain(needle);
      expect(scanOnlySource).not.toMatch(/\$execute|INSERT |UPDATE |DELETE |\.create\(|\.update|\.delete/);
    });
    test('the dispatch happens before any Bitrix-capable code path of the other modes', () => {
      expect(source.indexOf('if (options.scanOnly) return runScanOnly(env);')).toBeGreaterThan(-1);
      expect(source.indexOf('if (options.scanOnly) return runScanOnly(env);')).toBeLessThan(source.indexOf("require('../src/modules/bitrix/bitrix-deal.api')"));
    });
  });

  test('the network guard allows only crm.deal.get x2, crm.item.get x1 and ONE file GET, all on the pinned host', async () => {
    const calls = [];
    const original = global.fetch;
    global.fetch = jest.fn(async (url) => { calls.push(String(url)); return { ok: true }; });
    try {
      const guard = runner.makeGuard(HOST);
      const post = (m) => guard.fetchImpl(`https://${HOST}/rest/1/token/${m}.json`, { method: 'POST' });
      await post('crm.deal.get'); await post('crm.deal.get'); await post('crm.item.get');
      await guard.fetchImpl(`https://${HOST}/download/file.pdf`, { method: 'GET' });
      expect(calls).toHaveLength(4);
      await expect(post('crm.deal.get')).rejects.toThrow(/limit/);
      await expect(post('crm.item.get')).rejects.toThrow(/limit/);
      await expect(guard.fetchImpl(`https://${HOST}/download/other.pdf`, { method: 'GET' })).rejects.toThrow(/one download/);
      expect(calls).toHaveLength(4);
    } finally { global.fetch = original; }
  });
  test.each(['crm.deal.add', 'crm.deal.update', 'crm.item.update', 'crm.item.add', 'crm.deal.delete', 'crm.deal.list', 'crm.lead.add', 'user.get'])('the guard refuses %s before it leaves the machine', async (method) => {
    const guard = runner.makeGuard(HOST);
    global.fetch = jest.fn();
    await expect(guard.fetchImpl(`https://${HOST}/rest/1/token/${method}.json`, { method: 'POST' })).rejects.toThrow(/only crm\.deal\.get/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('the guard refuses another host and a non-GET download', async () => {
    const guard = runner.makeGuard(HOST);
    global.fetch = jest.fn();
    await expect(guard.fetchImpl('https://evil.example/rest/1/t/crm.deal.get.json', { method: 'POST' })).rejects.toThrow(/host/);
    await expect(guard.fetchImpl(`https://${HOST}/download/x`, { method: 'POST' })).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('the Bitrix client the services see has no working write method', async () => {
    const guard = runner.makeGuard(HOST);
    const api = runner.makeGuardedApi({ getDeal: jest.fn(), getDealFileField: jest.fn(), downloadBitrixFile: jest.fn(), BitrixDealCallError: Error }, guard);
    await expect(api.createDeal({})).rejects.toThrow(/disabled/);
    await expect(api.updateDealFiles('1', [])).rejects.toThrow(/disabled/);
    expect(guard.state.refused).toEqual(['createDeal', 'updateDealFiles']);
  });
  test('the runner source loads only .env.test, calls no Bitrix write method and has no way to name another Case', () => {
    const source = code('scripts/e2e-quotation-sync.js');
    expect(source).toContain("require('./e2e-env')");
    expect(source).not.toMatch(/realApi\.(createDeal|updateDealFiles|findDealsByReference)/);
    expect(source).not.toMatch(/dotenv|\.env['"]|process\.env\.DATABASE_URL/);
    expect(source).toContain('scope: { caseIds: [TARGET.caseId] }');
    expect(source).toContain('caseIds: [TARGET.caseId]');
    expect(source).not.toMatch(/--case-ids/);
  });
});

describe('what the quotation sync must never do', () => {
  test.each(NEW_SOURCES)('%s has no Bitrix write, no S3, no invoice / payment / notification access and sets no confirmed / published / accepted status', (rel) => {
    const source = code(rel);
    expect(source).not.toMatch(/crm\.deal\.(add|update|delete)|crm\.item\.(add|update|delete)|crm\.lead\.|createDeal\(|updateDealFiles\(|createLead\(/);
    expect(source).not.toMatch(/aws|S3Client|@aws-sdk/i);
    expect(source).not.toMatch(/\.(invoice|payment|notification|user)\b\.(create|update|upsert|delete|findMany|findUnique|findFirst)/);
    expect(source).not.toMatch(/status:\s*'(confirmed|published|accepted|rejected|superseded|withdrawn)'/);
    expect(source).not.toMatch(/sendExpoPush|pushToken/);
  });
  test('the existing Deal outbox store and worker are untouched by this feature', () => {
    expect(read('src/modules/bitrix/deal-outbox.store.js')).not.toMatch(/quotation/i);
    expect(read('src/modules/bitrix/deal-worker.service.js')).not.toMatch(/quotation/i);
  });
  test('the quotation modules do not use AWS directly (quotations still use their own local storage)', () => {
    for (const file of ['quotation-sync.service.js', 'quotation-scan.service.js', 'quotation-storage.js']) {
      expect(read('src/modules/bitrix/' + file)).not.toMatch(/aws-sdk|S3Client/);
    }
  });
});
