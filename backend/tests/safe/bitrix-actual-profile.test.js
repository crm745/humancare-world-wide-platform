/* global describe, test, expect, jest */
// The ACTUAL Air Ambulance pipeline profile (Category 0) beside the unchanged TEST pipeline (Category 38): profile selection, ids,
// Private Charter field mapping, multi Critical Level, manual cities, conditional oxygen flow, event/profile separation.
// Pure: no network, no database.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const {
  PROFILES, TEST_PROFILE, ACTUAL_PROFILE, ACTUAL_STAGES, ACTUAL_FIELD, ACTUAL_OPTIONS, ACTUAL_CRITICAL_LEVEL_MULTIPLE,
  lookupActualStage, documentsConfig, resolveProfile, profileForCategory, stampProfile, eventProfileProblem, assertDisjoint,
} = require('../../src/modules/bitrix/bitrix-profiles');
const { buildActualPrivateCharterFields } = require('../../src/modules/bitrix/bitrix-deal-actual');
const { buildDealFields, DealMappingError, DEAL, FIELD, DOCUMENTS_FIELD } = require('../../src/modules/bitrix/bitrix-deal');
const { STAGES, STAGE_LOST } = require('../../src/modules/bitrix/bitrix-deal-stages');
const { runDealWorker } = require('../../src/modules/bitrix/deal-worker.service');
const api = require('../../src/modules/bitrix/bitrix-deal.api');

// The real, verified option ids (the production configuration itself is used by default).
const OPTIONS = ACTUAL_OPTIONS;
const CONFIG = undefined;
const CASE = { referenceNumber: 'HC-2026-000123', patientName: 'Asha Rao' };
const REQUEST = {
  serviceKey: 'privatecharter', patientName: 'Asha Rao', patientAge: 54, patientGender: 'female', travelType: 'patient_transfer',
  origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates', description: 'Post-angioplasty, stable.',
  criticalLevel: 'icu,ecmo', oxygenRequired: true, oxygenFlowLpm: 4, country: 'IN', patientContact: '+919812345678',
  preferredDate: new Date('2026-12-05T00:00:00Z'),
};
const build = (over = {}, config = CONFIG) => buildActualPrivateCharterFields(CASE, { ...REQUEST, ...over }, config);
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e instanceof DealMappingError ? e.code : `other:${e.message}`; } };

describe('profile selection: no implicit default', () => {
  test('only the exact names resolve; unset, blank or unknown give no profile', () => {
    expect(resolveProfile({ BITRIX_DEAL_PROFILE: 'test' })).toBe(TEST_PROFILE);
    expect(resolveProfile({ BITRIX_DEAL_PROFILE: 'actual' })).toBe(ACTUAL_PROFILE);
    for (const env of [{}, { BITRIX_DEAL_PROFILE: '' }, { BITRIX_DEAL_PROFILE: 'ACTUAL ' + 'x' }, { BITRIX_DEAL_PROFILE: 'production' }, { BITRIX_DEAL_PROFILE: '__proto__' }, { BITRIX_DEAL_PROFILE: 'toString' }]) {
      expect(resolveProfile(env)).toBeNull();
    }
    expect(Object.keys(PROFILES).sort()).toEqual(['actual', 'test']);
  });
  test('a stored Bitrix category maps to its own profile only', () => {
    expect(profileForCategory('38')).toBe(TEST_PROFILE);
    expect(profileForCategory(38)).toBe(TEST_PROFILE);
    expect(profileForCategory('0')).toBe(ACTUAL_PROFILE);
    expect(profileForCategory(0)).toBe(ACTUAL_PROFILE);
    expect(profileForCategory(null)).toBeNull();
    expect(profileForCategory('7')).toBeNull();
  });
});

describe('actual pipeline: category and stages', () => {
  test('Air Ambulance is category 0 and the stage ids are the supplied ones', () => {
    expect(ACTUAL_PROFILE.categoryId).toBe(0);
    expect(ACTUAL_PROFILE.newStageId).toBe('NEW');
    const labels = Object.fromEntries(Object.entries(ACTUAL_STAGES).map(([id, s]) => [s.label, id]));
    expect(labels).toEqual({
      Enquiry: 'NEW', Quoted: 'UC_R55CKV', Confirmed: 'UC_9E9NRI', Activate: 'UC_HS6O2F', 'Case Completed': 'WON',
      Junk: 'UC_CFXC9U', 'Deal lost': 'LOSE', Duplicate: 'UC_ZSJGIL',
    });
  });
  test('Junk, Deal lost and Duplicate are not normal workflow stages', () => {
    expect(ACTUAL_PROFILE.workflowStageIds).toEqual(['NEW', 'UC_R55CKV', 'UC_9E9NRI', 'UC_HS6O2F', 'WON']);
    for (const id of ['UC_CFXC9U', 'LOSE', 'UC_ZSJGIL']) expect(ACTUAL_PROFILE.workflowStageIds).not.toContain(id);
  });
});

describe('test profile is unchanged and shares nothing with the actual one', () => {
  test('the test pipeline keeps its Category 38 ids', () => {
    expect(DEAL).toEqual({ CATEGORY_ID: 38, STAGE_ID: 'C38:NEW', SOURCE_ID: 'UC_0AYN3R' });
    expect(FIELD.PATIENT_NAME).toBe('UF_CRM_1775637288921');
    expect(DOCUMENTS_FIELD).toBe('UF_CRM_1794832401');
    expect(TEST_PROFILE.categoryId).toBe(38);
    expect(TEST_PROFILE.stageIds).toEqual([...Object.keys(STAGES), STAGE_LOST]);
    expect(Object.keys(STAGES).every((id) => id.startsWith('C38:'))).toBe(true);
  });
  test('no id is common to both, and the self-check passes', () => {
    expect(() => assertDisjoint()).not.toThrow();
    const testFields = new Set(Object.values(FIELD));
    for (const id of Object.values(ACTUAL_FIELD)) expect(testFields.has(id)).toBe(false);
    for (const id of ACTUAL_PROFILE.stageIds) expect(TEST_PROFILE.stageIds).not.toContain(id);
    expect(ACTUAL_PROFILE.documentsField).not.toBe(TEST_PROFILE.documentsField);
  });
  test('the test builder still builds a Category 38 Deal and never an actual field', () => {
    const fields = buildDealFields(CASE, { patientName: 'Asha Rao', patientGender: 'female' });
    expect(fields.CATEGORY_ID).toBe(38);
    expect(fields.STAGE_ID).toBe('C38:NEW');
    for (const id of Object.values(ACTUAL_FIELD)) expect(fields).not.toHaveProperty(id);
  });
});

describe('Private Charter field mapping (actual pipeline)', () => {
  test('the field ids are exactly the supplied ones', () => {
    expect(ACTUAL_FIELD).toEqual({
      PATIENT_NAME: 'UF_CRM_1795169868', PATIENT_AGE: 'UF_CRM_1795169999', GENDER: 'UF_CRM_1795170359', TRAVEL_TYPE: 'UF_CRM_1795170598',
      ORIGIN_CITY: 'UF_CRM_1795170760', DESTINATION_CITY: 'UF_CRM_1795170810', MEDICAL_HISTORY: 'UF_CRM_1795170937',
      CRITICAL_LEVEL: 'UF_CRM_1795171046', OXYGEN_REQUIRED: 'UF_CRM_1795171108', OXYGEN_FLOW_LPM: 'UF_CRM_1795171175',
      MEDICAL_REPORT: 'UF_CRM_1795171237', MEDICAL_REPORTS: 'UF_CRM_1795447841', COUNTRY: 'UF_CRM_1795171275', CONTACT_NUMBER: 'UF_CRM_1795171315', PREFERRED_DATE: 'UF_CRM_1795171360',
      CASE_REFERENCE: 'UF_CRM_1795176618',
    });
  });
  test('a full request maps every field into category 0, stage NEW', () => {
    expect(build()).toEqual({
      TITLE: 'HC-2026-000123', CATEGORY_ID: 0, STAGE_ID: 'NEW', UF_CRM_1795176618: 'HC-2026-000123',
      UF_CRM_1795169868: 'Asha Rao', UF_CRM_1795169999: 54, UF_CRM_1795170359: 6040, UF_CRM_1795170598: 6044,
      UF_CRM_1795170760: 'Mumbai, Maharashtra, India', UF_CRM_1795170810: 'Dubai, United Arab Emirates',
      UF_CRM_1795170937: 'Post-angioplasty, stable.', UF_CRM_1795171046: [6048, 6054],
      UF_CRM_1795171108: 6056, UF_CRM_1795171175: 4, UF_CRM_1795171275: 'IN', UF_CRM_1795171315: '+919812345678', UF_CRM_1795171360: '2026-12-05',
    });
  });
  test('Organ Transfer maps to its own option', () => {
    expect(build({ travelType: 'organ_transfer' })[ACTUAL_FIELD.TRAVEL_TYPE]).toBe(6046);
    expect(codeOf(() => build({ travelType: 'cargo' }))).toBe('travel_type_unknown');
  });
  test('the Medical Report file field is never written at creation, and nothing carries a path or a file id', () => {
    const fields = build({ medicalReportPath: '/tmp/x.pdf', documents: [{ id: 5 }] });
    expect(fields).not.toHaveProperty(ACTUAL_FIELD.MEDICAL_REPORT);
    expect(JSON.stringify(fields)).not.toMatch(/tmp|\.pdf/);
  });
  test('only Private Charter is mapped; Commercial Charter is refused', () => {
    expect(codeOf(() => build({ serviceKey: 'commercialair_stretcher' }))).toBe('service_not_mapped');
    expect(codeOf(() => build({ serviceKey: undefined }))).toBe('service_not_mapped');
  });
  test('the reference, a bad phone and a bad age are refused', () => {
    expect(codeOf(() => buildActualPrivateCharterFields({ referenceNumber: ' HC ' }, REQUEST, CONFIG))).toBe('reference_invalid');
    expect(codeOf(() => build({ patientContact: '98123' }))).toBe('mobile_not_e164');
    expect(codeOf(() => build({ patientAge: 0 }))).toBe('age_invalid');
  });
});

describe('Critical Level (multi-select)', () => {
  test('every selected value is kept, in the form order, as option ids', () => {
    expect(build({ criticalLevel: ['ecmo', 'icu'] })[ACTUAL_FIELD.CRITICAL_LEVEL]).toEqual([6048, 6054]);
    expect(build({ criticalLevel: 'icu,ventilated,tracheostomy,ecmo' })[ACTUAL_FIELD.CRITICAL_LEVEL]).toEqual([6048, 6050, 6052, 6054]);
    expect(build({ criticalLevel: 'ventilated' })[ACTUAL_FIELD.CRITICAL_LEVEL]).toEqual([6050]); // a value stored before the multi-select
  });
  test('a missing Critical Level is left out', () => {
    expect(build({ criticalLevel: null })).not.toHaveProperty(ACTUAL_FIELD.CRITICAL_LEVEL);
  });
  test('it is refused, not sent, while the field is not verified as multiple', () => {
    expect(codeOf(() => build({}, { options: OPTIONS, criticalLevelMultiple: null }))).toBe('enum_pending');
    expect(codeOf(() => build({}, { options: OPTIONS, criticalLevelMultiple: false }))).toBe('enum_pending');
  });
});

describe('Oxygen Required and Oxygen Flow Rate', () => {
  test('flow is sent only when oxygen is Yes', () => {
    const yes = build({ oxygenRequired: true, oxygenFlowLpm: 6 });
    expect(yes[ACTUAL_FIELD.OXYGEN_REQUIRED]).toBe(6056);
    expect(yes[ACTUAL_FIELD.OXYGEN_FLOW_LPM]).toBe(6);
    const no = build({ oxygenRequired: false, oxygenFlowLpm: 6 });
    expect(no[ACTUAL_FIELD.OXYGEN_REQUIRED]).toBe(6058);
    expect(no).not.toHaveProperty(ACTUAL_FIELD.OXYGEN_FLOW_LPM);
  });
  test('an unanswered oxygen sends neither', () => {
    const none = build({ oxygenRequired: null, oxygenFlowLpm: 6 });
    expect(none).not.toHaveProperty(ACTUAL_FIELD.OXYGEN_REQUIRED);
    expect(none).not.toHaveProperty(ACTUAL_FIELD.OXYGEN_FLOW_LPM);
  });
  test('a bad flow is refused', () => {
    expect(codeOf(() => build({ oxygenFlowLpm: 0 }))).toBe('oxygen_flow_invalid');
    expect(codeOf(() => build({ oxygenFlowLpm: 2.5 }))).toBe('oxygen_flow_invalid');
  });
});

describe('cities: GeoNames-picked and manual', () => {
  test('a GeoNames label and a manual name both go through as the readable text', () => {
    const fields = build({ origin: 'Smallville, India', destination: 'Karachi' });
    expect(fields[ACTUAL_FIELD.ORIGIN_CITY]).toBe('Smallville, India');
    expect(fields[ACTUAL_FIELD.DESTINATION_CITY]).toBe('Karachi');
  });
  test('accented and other-script manual names are kept as they are', () => {
    expect(build({ origin: 'Zürich', destination: '東京' })).toMatchObject({ [ACTUAL_FIELD.ORIGIN_CITY]: 'Zürich', [ACTUAL_FIELD.DESTINATION_CITY]: '東京' });
  });
});

describe('verified enum option ids', () => {
  test('every option id is the verified Bitrix enum id', () => {
    expect(ACTUAL_OPTIONS).toEqual({
      GENDER: { male: 6038, female: 6040, other: 6042 },
      TRAVEL_TYPE: { patient_transfer: 6044, organ_transfer: 6046 },
      CRITICAL_LEVEL: { icu: 6048, ventilated: 6050, tracheostomy: 6052, ecmo: 6054 },
      OXYGEN_REQUIRED: { yes: 6056, no: 6058 },
    });
    expect(ACTUAL_CRITICAL_LEVEL_MULTIPLE).toBe(true);
  });
  test.each([['male', 6038], ['female', 6040], ['other', 6042], [' Female ', 6040]])('gender %j -> %i on UF_CRM_1795170359', (value, id) => {
    expect(build({ patientGender: value })[ACTUAL_FIELD.GENDER]).toBe(id);
  });
  test.each([['patient_transfer', 6044], ['organ_transfer', 6046]])('travel type %s -> %i on UF_CRM_1795170598', (value, id) => {
    expect(build({ travelType: value })[ACTUAL_FIELD.TRAVEL_TYPE]).toBe(id);
  });
  test.each([['icu', 6048], ['ventilated', 6050], ['tracheostomy', 6052], ['ecmo', 6054]])('critical level %s -> [%i] on UF_CRM_1795171046', (value, id) => {
    expect(build({ criticalLevel: [value] })[ACTUAL_FIELD.CRITICAL_LEVEL]).toEqual([id]);
  });
  test('oxygen Yes -> 6056 and No -> 6058 on UF_CRM_1795171108', () => {
    expect(build({ oxygenRequired: true })[ACTUAL_FIELD.OXYGEN_REQUIRED]).toBe(6056);
    expect(build({ oxygenRequired: false })[ACTUAL_FIELD.OXYGEN_REQUIRED]).toBe(6058);
  });
  test('all four Critical Levels are kept, in the form order, whatever order they arrive in', () => {
    expect(build({ criticalLevel: ['ecmo', 'tracheostomy', 'icu', 'ventilated'] })[ACTUAL_FIELD.CRITICAL_LEVEL]).toEqual([6048, 6050, 6052, 6054]);
  });
  test('the outgoing payload carries the right field ids and the enum ids, never the labels', () => {
    const fields = build({ patientGender: 'male', travelType: 'organ_transfer', criticalLevel: ['icu', 'ecmo'], oxygenRequired: true, oxygenFlowLpm: 3 });
    expect(fields).toMatchObject({
      UF_CRM_1795170359: 6038, UF_CRM_1795170598: 6046, UF_CRM_1795171046: [6048, 6054], UF_CRM_1795171108: 6056, UF_CRM_1795171175: 3,
    });
    expect(JSON.stringify(fields)).not.toMatch(/"(male|organ_transfer|icu|ecmo|yes)"/);
  });
  test('an invalid or unmapped value fails closed (nothing to send)', () => {
    expect(codeOf(() => build({ patientGender: 'unknown' }))).toBe('gender_unknown');
    expect(codeOf(() => build({ travelType: 'cargo' }))).toBe('travel_type_unknown');
    expect(codeOf(() => build({ travelType: 'Patient Transfer' }))).toBe('travel_type_unknown'); // a label is not a key
    expect(codeOf(() => build({ patientGender: 'Male ' }))).toBeNull(); // trimmed and lowercased, still a known key
  });
  test('a value with no option id configured, or a list not known to be multiple, is refused', () => {
    expect(codeOf(() => build({}, { options: { ...ACTUAL_OPTIONS, GENDER: { male: null, female: null, other: null } } }))).toBe('enum_pending');
    expect(codeOf(() => build({}, { options: { ...ACTUAL_OPTIONS, TRAVEL_TYPE: { patient_transfer: null, organ_transfer: null } } }))).toBe('enum_pending');
    expect(codeOf(() => build({}, { options: { ...ACTUAL_OPTIONS, OXYGEN_REQUIRED: { yes: null, no: null } } }))).toBe('enum_pending');
    expect(codeOf(() => build({}, { options: { ...ACTUAL_OPTIONS, CRITICAL_LEVEL: { icu: null, ventilated: null, tracheostomy: null, ecmo: null } } }))).toBe('enum_pending');
    expect(codeOf(() => build({}, { options: ACTUAL_OPTIONS, criticalLevelMultiple: false }))).toBe('enum_pending');
  });
  test('Critical Level: an unknown key is refused and a duplicate is not sent twice', () => {
    expect(build({ criticalLevel: ['icu', 'icu', 'ecmo'] })[ACTUAL_FIELD.CRITICAL_LEVEL]).toEqual([6048, 6054]);
    expect(build({ criticalLevel: ['icu', 'bogus'] })[ACTUAL_FIELD.CRITICAL_LEVEL]).toEqual([6048]);
  });
});

describe('events stay with the profile they were queued for', () => {
  const test_ = resolveProfile({ BITRIX_DEAL_PROFILE: 'test' });
  const actual = resolveProfile({ BITRIX_DEAL_PROFILE: 'actual' });
  test('new events are stamped with the configured profile; with none configured nothing is stamped', () => {
    expect(stampProfile({ caseId: 1 }, { BITRIX_DEAL_PROFILE: 'actual' })).toEqual({ caseId: 1, profile: 'actual' });
    expect(stampProfile({ caseId: 1 }, { BITRIX_DEAL_PROFILE: 'test' })).toEqual({ caseId: 1, profile: 'test' });
    expect(stampProfile({ caseId: 1 }, {})).toEqual({ caseId: 1 });
  });
  test('a test event is refused by the actual profile, and an actual event by the test profile', () => {
    expect(eventProfileProblem({ profile: 'test' }, actual)).toBe('event_profile_mismatch');
    expect(eventProfileProblem({ profile: 'actual' }, test_)).toBe('event_profile_mismatch');
    expect(eventProfileProblem({ profile: 'test' }, test_)).toBeNull();
    expect(eventProfileProblem({ profile: 'actual' }, actual)).toBeNull();
  });
  test('an event with no stamp is a legacy test event: never accepted by the actual profile', () => {
    expect(eventProfileProblem({ caseId: 1 }, actual)).toBe('event_profile_mismatch');
    expect(eventProfileProblem(null, actual)).toBe('event_profile_mismatch');
    expect(eventProfileProblem({ caseId: 1 }, test_)).toBeNull();
  });
  test('an unknown stamp, or no active profile, is refused', () => {
    expect(eventProfileProblem({ profile: 'staging' }, test_)).toBe('event_profile_unknown');
    expect(eventProfileProblem({ profile: 'test' }, null)).toBe('profile_not_configured');
  });

  // The worker itself: nothing is called on Bitrix and the event is left alone.
  const ENV = { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
  function workerRun(profileEnv, payload) {
    const prisma = { case: { findUnique: jest.fn() } };
    const store = {
      MANUAL_REVIEW_PREFIX: 'manual_review', recoverExpiredLeases: jest.fn().mockResolvedValue(0),
      findCandidateIds: jest.fn(async (_p, status) => (status === 'pending' ? [9] : [])),
      claim: jest.fn(async () => ({ id: 9, fromStatus: 'pending', caseId: 1, attempts: 1, externalCallStartedAt: null, payload })),
      markExternalCallStarted: jest.fn(), complete: jest.fn(),
    };
    const fake = { createDeal: jest.fn(), findDealsByReference: jest.fn() };
    const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), log: jest.fn() };
    return runDealWorker({ prisma, store, api: fake, env: { ...ENV, ...profileEnv }, log, workerId: 'w', reportFailures: async () => 0 })
      .then((result) => ({ result, prisma, fake, store, log }));
  }
  test('the worker never loads or sends an event stamped for another profile', async () => {
    const { result, prisma, fake, log } = await workerRun({ BITRIX_DEAL_PROFILE: 'test' }, { caseId: 1, profile: 'actual' });
    expect(result).toEqual({ active: true, claimed: 1 });
    expect(prisma.case.findUnique).not.toHaveBeenCalled();
    expect(fake.createDeal).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('event_profile_mismatch'));
  });
  test('the worker running the actual profile refuses a legacy or test event, and lets only an actual-stamped one through to be processed', async () => {
    for (const payload of [{ caseId: 1 }, { caseId: 1, profile: 'test' }]) {
      const { prisma, fake } = await workerRun({ BITRIX_DEAL_PROFILE: 'actual' }, payload);
      expect(prisma.case.findUnique).not.toHaveBeenCalled();
      expect(fake.createDeal).not.toHaveBeenCalled();
    }
    const { prisma } = await workerRun({ BITRIX_DEAL_PROFILE: 'actual' }, { caseId: 1, profile: 'actual' });
    expect(prisma.case.findUnique).toHaveBeenCalled(); // past the gate: the Case is loaded (the full flow is exercised in bitrix-actual-e2e.test.js)
  });
  test('with no profile configured the worker sends nothing', async () => {
    const { prisma, fake, log } = await workerRun({}, { caseId: 1 });
    expect(prisma.case.findUnique).not.toHaveBeenCalled();
    expect(fake.createDeal).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('profile_not_configured'));
  });
});

describe('actual stages map to the existing HumanCare vocabulary', () => {
  test.each([
    ['NEW', 'patient_details', 'submitted', 'Request Received'],
    ['UC_R55CKV', 'quotation_ready', null, 'Quotation Ready'],
    ['UC_9E9NRI', 'payment_confirmed', null, 'Payment Confirmed'],
    ['UC_HS6O2F', 'in_progress', 'in_progress', 'Service In Progress'],
    ['WON', 'completed', 'completed', 'Completed'],
  ])('%s -> stage %s, case status %s, mobile "%s"', (id, key, status, mobileLabel) => {
    const found = lookupActualStage(id);
    expect(found.ok).toBe(true);
    expect(found.entry).toMatchObject({ key, status, mobileLabel });
  });
  test('every status written is one the Case already uses; null leaves the status as it is', () => {
    const existing = ['submitted', 'scheduled', 'in_progress', 'completed', 'cancelled', null];
    for (const id of ACTUAL_PROFILE.workflowStageIds) expect(existing).toContain(ACTUAL_STAGES[id].status);
  });
  test('no actual stage notifies the patient (Activate and Case Completed included) until that is separately approved', () => {
    for (const id of ACTUAL_PROFILE.stageIds) {
      expect(ACTUAL_STAGES[id].patientVisible || false).toBe(false);
      expect(ACTUAL_STAGES[id]).not.toHaveProperty('message');
    }
  });
  test('Junk, Deal lost, Duplicate, unknown, test-pipeline and missing stages are quarantined, never mapped', () => {
    expect(lookupActualStage('UC_CFXC9U')).toEqual({ ok: false, code: 'non_workflow_stage' });
    expect(lookupActualStage('LOSE')).toEqual({ ok: false, code: 'non_workflow_stage' });
    expect(lookupActualStage('UC_ZSJGIL')).toEqual({ ok: false, code: 'non_workflow_stage' });
    expect(lookupActualStage('C38:NEW')).toEqual({ ok: false, code: 'unknown_stage' });
    expect(lookupActualStage('C38:WON')).toEqual({ ok: false, code: 'unknown_stage' });
    expect(lookupActualStage('toString')).toEqual({ ok: false, code: 'unknown_stage' });
    expect(lookupActualStage('')).toEqual({ ok: false, code: 'stage_missing' });
    expect(lookupActualStage(undefined)).toEqual({ ok: false, code: 'stage_missing' });
  });
  test('the test pipeline lookup still refuses every actual stage id', () => {
    const { lookupStage } = require('../../src/modules/bitrix/bitrix-deal-stages');
    for (const id of ACTUAL_PROFILE.stageIds) expect(lookupStage(id, {}).ok).toBe(false);
  });
});

describe('Medical Reports field: MULTIPLE files, selected by the actual profile (the old single-file field is left alone)', () => {
  const { fileOptions } = require('../../src/modules/bitrix/deal-document-worker.service');
  const env = {
    BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
    BITRIX24_WEBHOOK_URL: 'https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/',
  };
  const ctx = { env };
  test('the profile names UF_CRM_1795447841 as a MULTIPLE-file field; the old single-file field is not used; the test profile stays multiple', () => {
    expect(ACTUAL_PROFILE.documentsField).toBe('UF_CRM_1795447841');
    expect(ACTUAL_PROFILE.documentsMultiple).toBe(true);
    expect(ACTUAL_PROFILE.documentsField).not.toBe(ACTUAL_FIELD.MEDICAL_REPORT);
    expect(ACTUAL_FIELD.MEDICAL_REPORT).toBe('UF_CRM_1795171237'); // kept as it was, never written
    expect(TEST_PROFILE.documentsField).toBe('UF_CRM_1794832401');
    expect(TEST_PROFILE.documentsMultiple).toBe(true);
    expect(documentsConfig(ACTUAL_PROFILE)).toEqual({ documentsField: 'UF_CRM_1795447841', documentsMultiple: true });
  });
  test('the worker picks the field from the Deal category: 0 -> the multiple actual field, 38 or none -> the unchanged test options', () => {
    expect(fileOptions(ctx, { categoryId: '0' })).toEqual({ env, documentsField: 'UF_CRM_1795447841', documentsMultiple: true });
    expect(fileOptions(ctx, { categoryId: 0 })).toEqual({ env, documentsField: 'UF_CRM_1795447841', documentsMultiple: true });
    expect(fileOptions(ctx, { categoryId: '38' })).toEqual({ env });
    expect(fileOptions(ctx, { categoryId: null })).toEqual({ env });
  });
  test('an unknown category is refused', () => {
    expect(() => fileOptions(ctx, { categoryId: '7' })).toThrow('unknown_bitrix_category');
  });
  test('missing or invalid profile metadata is refused: no field, a bad field name, or multiplicity not stated', () => {
    expect(documentsConfig(null)).toBeNull();
    expect(documentsConfig({ name: 'x' })).toBeNull();
    expect(documentsConfig({ documentsField: 'bad name', documentsMultiple: false })).toBeNull();
    expect(documentsConfig({ documentsField: 'UF_CRM_1795171237' })).toBeNull(); // multiplicity is never assumed
    expect(documentsConfig({ documentsField: 'UF_CRM_1795171237', documentsMultiple: 'no' })).toBeNull();
  });

  // The Deal's file field as the portal behaves: a SINGLE file field, and a write replaces it.
  const reply = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
  function fakePortal(initial) {
    const state = { value: initial, writes: [] };
    const fetchImpl = jest.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).includes('crm.item.get')) {
        return reply({ result: { item: { id: 77, UF_CRM_1795171237: state.value, UF_CRM_1794832401: [{ id: 4 }] } } });
      }
      state.writes.push(body.fields);
      state.value = { id: 9001 }; // replaced by the new file
      return reply({ result: { item: { id: 77 } } });
    });
    return { state, fetchImpl };
  }
  // The single-file behaviour of the API (still supported for a field declared single) is exercised with the OLD field named explicitly.
  const options = (portal) => ({ env, documentsField: 'UF_CRM_1795171237', documentsMultiple: false, fetchImpl: portal.fetchImpl });

  test('reads an empty single field as no files, and a filled one as exactly one id', async () => {
    expect(await api.getDealFiles('77', options(fakePortal(null)))).toEqual({ status: 'ok', ids: [] });
    expect(await api.getDealFiles('77', options(fakePortal({ id: 55, url: 'x', urlMachine: 'y' })))).toEqual({ status: 'ok', ids: ['55'] });
  });
  test('an unusable single-field shape is "uncertain", never an empty list', async () => {
    for (const value of [[{ id: 5 }], 'text', 7, { id: 0 }, { name: 'a.pdf' }]) {
      expect(await api.getDealFiles('77', options(fakePortal(value)))).toMatchObject({ status: 'uncertain', reason: 'unexpected_files_shape' });
    }
  });
  test('attaching into the EMPTY field sends one [name, base64] pair under the single field key, and nothing else', async () => {
    const portal = fakePortal(null);
    await api.updateDealFiles('77', [{ fileData: ['report.pdf', 'QQ=='] }], options(portal));
    expect(portal.state.writes).toEqual([{ ufCrm_1795171237: ['report.pdf', 'QQ=='] }]);
    expect(await api.getDealFiles('77', options(portal))).toEqual({ status: 'ok', ids: ['9001'] }); // the worker then sees exactly one new id
  });
  test('an OCCUPIED field is never overwritten: the list the worker builds (existing id + new file) is refused before any call', async () => {
    const portal = fakePortal({ id: 55 });
    await expect(api.updateDealFiles('77', [{ id: 55 }, { fileData: ['report.pdf', 'QQ=='] }], options(portal))).rejects.toMatchObject({ outcome: 'definitive', code: 'single_file_field_occupied' });
    expect(portal.fetchImpl).not.toHaveBeenCalled();
    expect(portal.state.value).toEqual({ id: 55 });
  });
  test('clearing a single field is not supported (its form is unverified): refused before any call', async () => {
    const portal = fakePortal({ id: 55 });
    await expect(api.updateDealFiles('77', [], { ...options(portal), allowEmpty: true })).rejects.toMatchObject({ outcome: 'definitive', code: 'single_file_change_unsupported' });
    await expect(api.updateDealFiles('77', [{ id: 55 }], options(portal))).rejects.toMatchObject({ code: 'single_file_change_unsupported' });
    expect(portal.fetchImpl).not.toHaveBeenCalled();
  });
  test('a malformed new file, a bad field and an unstated multiplicity are refused before any call', async () => {
    const portal = fakePortal(null);
    await expect(api.updateDealFiles('77', [{ fileData: ['', 'QQ=='] }], options(portal))).rejects.toMatchObject({ code: 'file_entry_invalid' });
    await expect(api.updateDealFiles('77', [{ fileData: ['a.pdf', 'QQ=='] }], { env, fetchImpl: portal.fetchImpl, documentsField: 'UF_CRM_1795171237' })).rejects.toMatchObject({ code: 'documents_field_invalid' });
    await expect(api.updateDealFiles('77', [{ fileData: ['a.pdf', 'QQ=='] }], { env, fetchImpl: portal.fetchImpl, documentsField: 'x; y', documentsMultiple: false })).rejects.toMatchObject({ code: 'documents_field_invalid' });
    expect((await api.getDealFiles('77', { env, fetchImpl: portal.fetchImpl, documentsField: 'UF_CRM_1795171237' })).reason).toBe('documents_field_invalid');
    expect(portal.fetchImpl).not.toHaveBeenCalled();
  });
  test('the actual profile MULTIPLE field appends a second file and keeps the files Operations already put there', async () => {
    const bodies = [];
    const fetchImpl = jest.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (String(url).includes('crm.item.get')) return reply({ result: { item: { id: 77, UF_CRM_1795447841: [{ id: 11 }, { id: 12 }], UF_CRM_1795171237: { id: 55 } } } });
      return reply({ result: { item: { id: 77 } } });
    });
    const actualOptions = { ...fileOptions(ctx, { categoryId: '0' }), fetchImpl };
    expect(await api.getDealFiles('77', actualOptions)).toEqual({ status: 'ok', ids: ['11', '12'] }); // the old single field (55) is not read
    await api.updateDealFiles('77', [{ id: 11 }, { id: 12 }, { fileData: ['second.pdf', 'QQ=='] }], actualOptions);
    expect(bodies[1].fields).toEqual({ ufCrm_1795447841: [{ id: 11 }, { id: 12 }, ['second.pdf', 'QQ==']] });
    expect(JSON.stringify(bodies[1])).not.toContain('1795171237'); // the old field is never written
  });
  test('the existing multiple-field behaviour of the test pipeline is unchanged', async () => {
    const bodies = [];
    const fetchImpl = jest.fn(async (_u, init) => { bodies.push(JSON.parse(init.body)); return reply({ result: { item: { id: 77, UF_CRM_1794832401: [{ id: 4 }] } } }); });
    expect(await api.getDealFiles('77', { env, fetchImpl })).toEqual({ status: 'ok', ids: ['4'] });
    await api.updateDealFiles('77', [{ id: 4 }, { fileData: ['a.pdf', 'QQ=='] }], { env, fetchImpl });
    expect(bodies[1].fields).toEqual({ ufCrm_1794832401: [{ id: 4 }, ['a.pdf', 'QQ==']] });
    expect(await api.getDealFiles('77', { env, fetchImpl, documentsField: 'UF_CRM_1794832401', documentsMultiple: true })).toEqual({ status: 'ok', ids: ['4'] });
  });
});
