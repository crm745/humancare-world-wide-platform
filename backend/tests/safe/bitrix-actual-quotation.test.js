/* global describe, test, expect, jest, beforeEach, afterEach */
// Quotation synchronization for the ACTUAL Air Ambulance pipeline (Category 0): the PDF is UF_CRM_1795177914, the final amount and currency are
// the Deal's standard OPPORTUNITY and CURRENCY_ID. Runs the real sync service on the shared in-memory rig (fake Prisma, real temp-folder storage,
// a fake Bitrix client that only reads). No database, no network. The test pipeline's quotation behaviour is checked alongside as a regression.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const kit = require('./quotation-test-kit');
const { ACTUAL_PROFILE, TEST_PROFILE, ACTUAL_QUOTATION_FIELD, quotationFieldsOf, quotationFieldsForProfile, assertDisjoint } = require('../../src/modules/bitrix/bitrix-profiles');
const { runQuotationSync, processQuotationEvent, MAX_ATTEMPTS } = require('../../src/modules/bitrix/quotation-sync.service');
const { detectAndEnqueueQuotationSync, readQuotationSignature, QUOTATION_FIELD } = require('../../src/modules/bitrix/quotation-outbox');

const { DEAL, REF, pdf, sha } = kit;
const ENV_ACTUAL = { ...kit.ENV_ON, BITRIX_DEAL_PROFILE: 'actual' };
const ENV_TEST = { ...kit.ENV_ON, BITRIX_DEAL_PROFILE: 'test' };
const ACTUAL_REF_FIELD = 'UF_CRM_1795176618';
const TEST_FILE = 'UF_CRM_1794985313';

// A Deal as crm.deal.get returns it for the actual pipeline. The test pipeline's quotation custom fields carry DIFFERENT values on purpose,
// so reading one of them by mistake shows up as a wrong value.
const actualDeal = ({ fileId = 65900, amount = '2500.00', currency = 'USD', stage = 'UC_R55CKV', category = '0', ref = REF } = {}) => ({
  ID: DEAL, CATEGORY_ID: category, STAGE_ID: stage, DATE_MODIFY: '2030-01-02T10:00:00+00:00', [ACTUAL_REF_FIELD]: ref,
  UF_CRM_1795177914: fileId == null ? null : { id: fileId, showUrl: '/x', downloadUrl: '/y' },
  ...(amount === undefined ? {} : { OPPORTUNITY: amount }), CURRENCY_ID: currency,
  // decoys: the test pipeline's fields
  [TEST_FILE]: { id: 11 }, UF_CRM_6A3399F56ECFF: '999.00', UF_CRM_6A23F4E86AA45: 'INR', UF_CRM_1794548440549: REF,
});

let rig;
const actualLink = { id: 1173, caseId: 3037, bitrixDealId: DEAL, profile: 'actual' };
beforeEach(() => {
  rig = kit.makeRig({ link: { ...actualLink } });
  rig.state.deal = actualDeal();
  // a fake that reads the file field the service ASKS for (so a wrong field name is visible) and records every field it is asked about
  rig.fileFieldsAsked = [];
  rig.api.getDealFileField = jest.fn(async (_dealId, field) => {
    rig.api.calls.push('crm.item.get');
    rig.fileFieldsAsked.push(field);
    const value = rig.state.deal[field];
    return { status: 'ok', file: value ? { id: String(value.id) } : null };
  });
});
afterEach(() => rig.cleanup());

const detect = (profile = ACTUAL_PROFILE) => detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal, profile);
const pass = (env = ENV_ACTUAL, extra = {}) => runQuotationSync(rig.ctx({ env, ...extra }));
const rows = () => rig.world.quotations;
const event = (id) => rig.world.events.find((e) => e.id === id);

describe('the actual profile\'s quotation fields', () => {
  test('are exactly UF_CRM_1795177914 (PDF), OPPORTUNITY (amount) and CURRENCY_ID (currency)', () => {
    expect(ACTUAL_QUOTATION_FIELD).toEqual({ FILE: 'UF_CRM_1795177914', AMOUNT: 'OPPORTUNITY', CURRENCY: 'CURRENCY_ID' });
    expect(ACTUAL_PROFILE.quotationFields).toBe(ACTUAL_QUOTATION_FIELD);
    expect(quotationFieldsOf(ACTUAL_PROFILE.quotationFields)).toEqual(ACTUAL_QUOTATION_FIELD);
  });
  test('the test profile\'s quotation fields are unchanged and share nothing with the actual ones', () => {
    expect(TEST_PROFILE.quotationFields).toBe(QUOTATION_FIELD);
    expect(QUOTATION_FIELD).toEqual({ FILE: 'UF_CRM_1794985313', AMOUNT: 'UF_CRM_6A3399F56ECFF', CURRENCY: 'UF_CRM_6A23F4E86AA45' });
    for (const code of Object.values(ACTUAL_QUOTATION_FIELD)) expect(Object.values(QUOTATION_FIELD)).not.toContain(code);
    expect(() => assertDisjoint()).not.toThrow();
  });
  test('the Quotation PDF is documented and enforced as a SINGLE-file field (Multiple: No)', () => {
    expect(ACTUAL_PROFILE.quotationFileMultiple).toBe(false);
    expect(quotationFieldsForProfile(ACTUAL_PROFILE)).toEqual(ACTUAL_QUOTATION_FIELD);
    // multiplicity is never assumed: a non-test profile must state `false`
    for (const quotationFileMultiple of [undefined, null, true, 'false', 0]) {
      expect(quotationFieldsForProfile({ ...ACTUAL_PROFILE, quotationFileMultiple })).toBeNull();
    }
  });
  test('the test profile is untouched: it states no multiplicity, still resolves, and cannot be set to multiple', () => {
    expect(TEST_PROFILE).not.toHaveProperty('quotationFileMultiple');
    expect(quotationFieldsForProfile(TEST_PROFILE)).toEqual(QUOTATION_FIELD);
    expect(quotationFieldsForProfile({ ...TEST_PROFILE, quotationFileMultiple: true })).toBeNull();
  });
  test.each([
    ['nothing', undefined], ['null', null], ['a string', 'UF_CRM_1795177914'],
    ['no file', { AMOUNT: 'OPPORTUNITY', CURRENCY: 'CURRENCY_ID' }],
    ['a file that is not a UF_CRM_ field', { FILE: 'TITLE', AMOUNT: 'OPPORTUNITY', CURRENCY: 'CURRENCY_ID' }],
    ['a bad amount field', { FILE: 'UF_CRM_1795177914', AMOUNT: 'COMMENTS', CURRENCY: 'CURRENCY_ID' }],
    ['a bad currency field', { FILE: 'UF_CRM_1795177914', AMOUNT: 'OPPORTUNITY', CURRENCY: 'x; y' }],
    ['the same field twice', { FILE: 'UF_CRM_1795177914', AMOUNT: 'UF_CRM_1795177914', CURRENCY: 'CURRENCY_ID' }],
  ])('%s is not a usable configuration', (_name, fields) => {
    expect(quotationFieldsOf(fields)).toBeNull();
  });
});

describe('reading the quotation from an actual Deal', () => {
  test('the signature takes the file, amount and currency from the actual fields and ignores the test pipeline\'s', () => {
    const deal = actualDeal();
    expect(readQuotationSignature(deal, ACTUAL_QUOTATION_FIELD)).toEqual({ fileId: '65900', amountRaw: '2500.00', currencyRaw: 'USD' });
    // the same Deal read with the TEST fields shows what a mix-up would give
    expect(readQuotationSignature(deal, QUOTATION_FIELD)).toEqual({ fileId: '11', amountRaw: '999.00', currencyRaw: 'INR' });
  });
  test('detection queues one event for the actual Deal, stamped actual', async () => {
    expect(await detect()).toEqual({ queued: true, reason: 'queued' });
    expect(rig.world.events[rig.world.events.length - 1] || event(464)).toBeTruthy();
    expect(rig.world.events[0].payload).toMatchObject({ caseId: 3037, dealId: DEAL, fileId: '65900', profile: 'actual' });
  });
  test('a finished Deal (Case Completed, Deal lost) queues nothing', async () => {
    for (const stage of ['WON', 'LOSE']) {
      rig.state.deal = actualDeal({ stage });
      expect(await detect()).toEqual({ queued: false, reason: 'deal_closed' });
    }
    expect(rig.world.events).toHaveLength(0);
  });
  test('no file queues nothing', async () => {
    rig.state.deal = actualDeal({ fileId: null });
    expect(await detect()).toEqual({ queued: false, reason: 'unchanged' });
  });
});

describe('PDF retrieval and the version it creates', () => {
  test('the sync asks for UF_CRM_1795177914 only, downloads once, writes nothing to Bitrix, and stores the actual amount and currency', async () => {
    await detect();
    const result = await pass();
    expect(result).toMatchObject({ active: true, claimed: 1 });
    expect(result.results[0]).toMatchObject({ outcome: 'created', versionNumber: 1 });

    expect(rig.fileFieldsAsked).toEqual(['UF_CRM_1795177914']); // never the test pipeline's UF_CRM_1794985313
    expect(rig.api.calls).toEqual(['crm.deal.get', 'crm.item.get', 'download']);
    expect(rig.api.createDeal).not.toHaveBeenCalled();
    expect(rig.api.updateDealFiles).not.toHaveBeenCalled();

    const [q] = rows();
    expect(q).toMatchObject({
      caseId: 3037, versionNumber: 1, status: 'draft', scanStatus: 'pending', amount: '2500.00', currency: 'USD', validationError: null,
      bitrixAmountRaw: '2500.00', bitrixCurrencyRaw: 'USD', bitrixFileId: '65900', bitrixDealId: DEAL, bitrixDealStageId: 'UC_R55CKV',
      sizeBytes: rig.state.pdf.length, sha256: sha(rig.state.pdf), confirmedAt: null, publishedAt: null,
    });
    expect(rig.filesOnDisk()).toEqual([q.storageKey]);
    expect(event(464)).toMatchObject({ status: 'completed', attempts: 1 });
  });
  test('nothing of the test pipeline\'s decoy fields is stored', async () => {
    await detect();
    await pass();
    const stored = JSON.stringify(rows()[0]);
    expect(stored).not.toContain('999.00');
    expect(stored).not.toContain('INR');
    expect(rows()[0].bitrixFileId).not.toBe('11');
  });
  test('a changed amount in Bitrix\'s Amount and currency control updates the working draft (same PDF)', async () => {
    await detect();
    await pass();
    rig.state.deal = actualDeal({ amount: '2750.00' });
    await detect();
    await pass();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ amount: '2750.00', currency: 'USD', bitrixAmountRaw: '2750.00' });
  });
  test('a download refused by the PDF check stores nothing and fails the event', async () => {
    rig.state.downloadError = Object.assign(new rig.api.BitrixDealCallError('definitive', 'not_a_pdf'), { outcome: 'definitive' });
    await detect();
    await pass();
    expect(rows()).toHaveLength(0);
    expect(event(464)).toMatchObject({ status: 'failed' });
  });
});

describe('amount and currency mapping (the standard OPPORTUNITY and CURRENCY_ID)', () => {
  const syncWith = async (money) => {
    rig.state.deal = actualDeal(money);
    await detect();
    await pass();
    return rows()[0];
  };
  test.each([
    ['2500.00', 'USD', '2500.00'], ['1500.5', 'USD', '1500.50'], ['1500', 'INR', '1500.00'], ['1500', 'JPY', '1500'], ['1500.000', 'KWD', '1500.000'],
  ])('amount %s %s is stored exactly as %s', async (amount, currency, expected) => {
    expect(await syncWith({ amount, currency })).toMatchObject({ amount: expected, currency, validationError: null });
  });
  test('Bitrix may send the amount as a number', async () => {
    expect(await syncWith({ amount: 1500, currency: 'AED' })).toMatchObject({ amount: '1500.00', currency: 'AED', validationError: null });
  });
  test.each([
    ['an empty Amount (Bitrix\'s default 0.00)', { amount: '0.00', currency: 'USD' }, 'amount_not_positive'],
    ['no amount', { amount: null, currency: 'USD' }, 'amount_missing'],
    ['no currency', { amount: '100.00', currency: '' }, 'currency_missing'],
    ['an invalid amount', { amount: '12,50', currency: 'USD' }, 'amount_invalid'],
    ['a currency that is not three letters', { amount: '100.00', currency: 'usd' }, 'currency_invalid'],
    ['more decimals than the currency has', { amount: '10.005', currency: 'USD' }, 'amount_precision'],
    ['an unsupported currency', { amount: '100.00', currency: 'ZZZ' }, 'currency_unsupported'],
  ])('%s keeps the pair empty with %s, so the quotation can never be confirmed', async (_name, money, code) => {
    expect(await syncWith(money)).toMatchObject({ amount: null, currency: null, validationError: code });
  });
});

describe('missing or invalid quotation configuration: fail closed', () => {
  const realProfiles = require('../../src/modules/bitrix/bitrix-profiles');
  // Runs the REAL services against an actual profile whose quotation fields are replaced (isolated module registry).
  const withQuotationFields = (quotationFields) => {
    let loaded;
    jest.isolateModules(() => {
      const broken = Object.freeze({ ...realProfiles.ACTUAL_PROFILE, quotationFields });
      jest.doMock('../../src/modules/bitrix/bitrix-profiles', () => ({
        ...realProfiles, ACTUAL_PROFILE: broken, PROFILES: { ...realProfiles.PROFILES, actual: broken },
        resolveProfile: (env) => (env && env.BITRIX_DEAL_PROFILE === 'actual' ? broken : realProfiles.resolveProfile(env)),
      }));
      loaded = { sync: require('../../src/modules/bitrix/quotation-sync.service'), outbox: require('../../src/modules/bitrix/quotation-outbox'), broken };
    });
    jest.dontMock('../../src/modules/bitrix/bitrix-profiles');
    return loaded;
  };

  test.each([
    ['null', null], ['missing', undefined], ['no file field', { AMOUNT: 'OPPORTUNITY', CURRENCY: 'CURRENCY_ID' }],
    ['the test pipeline\'s fields copied in with a bad file', { FILE: 'FILE', AMOUNT: 'UF_CRM_6A3399F56ECFF', CURRENCY: 'UF_CRM_6A23F4E86AA45' }],
    ['a field repeated', { FILE: 'UF_CRM_1795177914', AMOUNT: 'OPPORTUNITY', CURRENCY: 'OPPORTUNITY' }],
  ])('%s: detection queues nothing and the sync fails the event without reading Bitrix or storing anything', async (_name, fields) => {
    const svc = withQuotationFields(fields);
    expect(await svc.outbox.detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal, svc.broken)).toEqual({ queued: false, reason: 'quotation_not_configured' });
    expect(rig.world.events).toHaveLength(0);

    // an event that was queued anyway (before the configuration broke) is refused, not processed
    kit.addEvent(rig.world, { payload: { caseId: 3037, dealId: DEAL, fileId: '65900', profile: 'actual' } });
    await svc.sync.runQuotationSync(rig.ctx({ env: ENV_ACTUAL }));
    expect(rig.api.getDeal).not.toHaveBeenCalled();
    expect(rig.fileFieldsAsked).toEqual([]);
    expect(rig.api.downloadBitrixFile).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    expect(rig.world.events[0]).toMatchObject({ status: 'failed', lastError: 'quotation_not_configured' });
  });
});

describe('the single-file rule on the actual quotation PDF', () => {
  const realProfiles2 = require('../../src/modules/bitrix/bitrix-profiles');
  test.each([['not stated', undefined], ['true', true], ['null', null], ['the text "false"', 'false']])(
    'a profile whose quotationFileMultiple is %s is refused: nothing is queued, read or stored', async (_name, quotationFileMultiple) => {
      let svc;
      jest.isolateModules(() => {
        const broken = Object.freeze({ ...realProfiles2.ACTUAL_PROFILE, quotationFileMultiple });
        jest.doMock('../../src/modules/bitrix/bitrix-profiles', () => ({
          ...realProfiles2, ACTUAL_PROFILE: broken, PROFILES: { ...realProfiles2.PROFILES, actual: broken },
          resolveProfile: (env) => (env && env.BITRIX_DEAL_PROFILE === 'actual' ? broken : realProfiles2.resolveProfile(env)),
        }));
        svc = { sync: require('../../src/modules/bitrix/quotation-sync.service'), outbox: require('../../src/modules/bitrix/quotation-outbox'), broken };
      });
      jest.dontMock('../../src/modules/bitrix/bitrix-profiles');
      expect(await svc.outbox.detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal, svc.broken)).toEqual({ queued: false, reason: 'quotation_not_configured' });
      kit.addEvent(rig.world, { payload: { caseId: 3037, dealId: DEAL, profile: 'actual' } });
      await svc.sync.runQuotationSync(rig.ctx({ env: ENV_ACTUAL }));
      expect(rig.api.getDeal).not.toHaveBeenCalled();
      expect(rig.api.downloadBitrixFile).not.toHaveBeenCalled();
      expect(rows()).toHaveLength(0);
      expect(rig.world.events[0]).toMatchObject({ status: 'failed', lastError: 'quotation_not_configured' });
    });

  // What a MULTIPLE field returns is a list; a single field returns one object or nothing.
  const oneFile = { id: 65900, showUrl: '/x', downloadUrl: '/y' };
  test.each([
    ['a list with one file', [oneFile]], ['a list with two files', [oneFile, { id: 65901 }]], ['text', 'file'],
  ])('%s in the Deal is not read as the one file: no event is queued', async (_name, value) => {
    rig.state.deal = { ...actualDeal(), UF_CRM_1795177914: value };
    expect(await detect()).toEqual({ queued: false, reason: 'file_unreadable' });
    expect(rig.world.events).toHaveLength(0);
  });
  test.each([['a list with one file', [oneFile]], ['a list with two files', [oneFile, { id: 65901 }]]])(
    'an event that meets %s retries and finally fails; no file is requested, downloaded or stored', async (_name, value) => {
      rig.state.deal = { ...actualDeal(), UF_CRM_1795177914: value };
      kit.addEvent(rig.world, { payload: { caseId: 3037, dealId: DEAL, profile: 'actual' } });
      await pass();
      expect(event(464)).toMatchObject({ status: 'pending', lastError: 'file_field_unreadable' });
      for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
        rig.world.clock += 24 * 3600 * 1000;
        await pass();
      }
      expect(event(464)).toMatchObject({ status: 'failed', lastError: 'file_field_unreadable' });
      expect(rig.fileFieldsAsked).toEqual([]);
      expect(rig.api.downloadBitrixFile).not.toHaveBeenCalled();
      expect(rows()).toHaveLength(0);
    });
  test('if the file read itself answers with a list, the event retries without downloading', async () => {
    rig.api.getDealFileField = jest.fn(async () => ({ status: 'uncertain', reason: 'unexpected_file_shape' }));
    kit.addEvent(rig.world, { payload: { caseId: 3037, dealId: DEAL, profile: 'actual' } });
    await pass();
    expect(event(464)).toMatchObject({ status: 'pending', lastError: 'bitrix_file_read_failed' });
    expect(rig.api.downloadBitrixFile).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });
  test('the real file read refuses a list (even of one file) and accepts exactly one object', async () => {
    const api = require('../../src/modules/bitrix/bitrix-deal.api');
    const env = { ...kit.ENV_ON, BITRIX24_WEBHOOK_URL: 'https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/' };
    const answer = (value) => jest.fn(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ result: { item: { id: 77, UF_CRM_1795177914: value } } }) }));
    for (const value of [[{ id: 5, urlMachine: 'https://x/y' }], [{ id: 5 }, { id: 6 }]]) {
      expect(await api.getDealFileField('77', 'UF_CRM_1795177914', { env, fetchImpl: answer(value) })).toMatchObject({ status: 'uncertain', reason: 'unexpected_file_shape' });
    }
    expect(await api.getDealFileField('77', 'UF_CRM_1795177914', { env, fetchImpl: answer({ id: 5, urlMachine: 'https://fake-bitrix.invalid/d/5' }) })).toMatchObject({ status: 'ok', file: { id: '5' } });
    expect(await api.getDealFileField('77', 'UF_CRM_1795177914', { env, fetchImpl: answer(null) })).toEqual({ status: 'ok', file: null });
  });
  test('exactly one file is read and downloaded on the normal path', async () => {
    await detect();
    await pass();
    expect(rig.fileFieldsAsked).toEqual(['UF_CRM_1795177914']);
    expect(rig.api.downloadBitrixFile).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });
});

describe('cross-profile rejection', () => {
  const queued = () => kit.addEvent(rig.world, { payload: { caseId: 3037, dealId: DEAL, fileId: '65900', profile: 'actual' } });

  test.each([
    ['an actual link under the test profile', 'actual', ENV_TEST],
    ['a test link under the actual profile', 'test', ENV_ACTUAL],
    ['a legacy (unstamped) link under the actual profile', null, ENV_ACTUAL],
  ])('%s is never read: nothing is called, stored or recorded', async (_name, linkProfile, env) => {
    rig.world.link.profile = linkProfile;
    queued();
    expect((await pass(env)).results[0]).toMatchObject({ outcome: 'link_profile_mismatch' });
    expect(rig.api.getDeal).not.toHaveBeenCalled();
    expect(rig.fileFieldsAsked).toEqual([]);
    expect(rows()).toHaveLength(0);
    expect(rig.world.audit).toHaveLength(0);
  });
  test('with no profile configured nothing is read', async () => {
    queued();
    await pass({ ...kit.ENV_ON, BITRIX_DEAL_PROFILE: undefined });
    expect(rig.api.getDeal).not.toHaveBeenCalled();
  });
  test('a Category 38 Deal behind an actual link is refused: its quotation fields are never read', async () => {
    rig.state.deal = actualDeal({ category: '38' });
    queued();
    await pass();
    expect(rig.api.getDeal).toHaveBeenCalledTimes(1);
    expect(rig.fileFieldsAsked).toEqual([]);
    expect(rig.api.downloadBitrixFile).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    expect(rig.world.events[0]).toMatchObject({ status: 'failed', lastError: 'category_mismatch' });
  });
  test('an actual Deal whose Case Reference field does not match is refused, even if the test reference field matches', async () => {
    rig.state.deal = actualDeal({ ref: 'CASE-OTHER' });
    queued();
    await pass();
    expect(rig.fileFieldsAsked).toEqual([]);
    expect(rows()).toHaveLength(0);
    expect(rig.world.events[0]).toMatchObject({ status: 'failed', lastError: 'reference_mismatch' });
  });
  test('an actual Deal that only has the test pipeline\'s quotation file is "no file": nothing is fetched', async () => {
    rig.state.deal = { ...actualDeal({ fileId: null }) }; // UF_CRM_1795177914 empty, the decoy test file still set
    queued();
    const result = await pass();
    expect(result.results[0]).toMatchObject({ outcome: 'no_file' });
    expect(rig.fileFieldsAsked).toEqual([]);
    expect(rig.api.downloadBitrixFile).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });
  test('the quotation store offers only the active profile\'s events', async () => {
    const { findCandidateIds } = require('../../src/modules/bitrix/quotation-sync.store');
    const db = { $queryRawUnsafe: jest.fn(async () => []) };
    await findCandidateIds(db, 5, undefined, 'actual');
    expect(db.$queryRawUnsafe.mock.calls[0].slice(1)).toContain('actual');
  });
});

describe('regression: the test profile\'s quotation sync is unchanged', () => {
  test('it asks for UF_CRM_1794985313 and reads the test amount and currency fields', async () => {
    rig.world.link.profile = 'test';
    rig.state.deal = kit.dealBody({ fileId: 65834, amount: '1000.00', currency: 'INR' });
    rig.api.getDealFileField = jest.fn(async (_d, field) => { rig.fileFieldsAsked.push(field); return { status: 'ok', file: { id: '65834' } }; });
    await detectAndEnqueueQuotationSync(rig.prisma, rig.world.caseRecord, rig.state.deal, TEST_PROFILE);
    const result = await pass(ENV_TEST);
    expect(result.results[0]).toMatchObject({ outcome: 'created' });
    expect(rig.fileFieldsAsked).toEqual([TEST_FILE]);
    expect(rows()[0]).toMatchObject({ amount: '1000.00', currency: 'INR', bitrixFileId: '65834', bitrixDealStageId: 'C38:NEW' });
  });
  test('an event with the test profile still ignores an actual Deal\'s standard Amount field', async () => {
    const deal = kit.dealBody({ fileId: 65834, amount: undefined, currency: '' });
    expect(readQuotationSignature({ ...deal, OPPORTUNITY: '777.00', CURRENCY_ID: 'EUR' }, QUOTATION_FIELD)).toMatchObject({ amountRaw: null, currencyRaw: null });
  });
  test('processQuotationEvent is still exported and runs per profile', () => {
    expect(typeof processQuotationEvent).toBe('function');
  });
});
