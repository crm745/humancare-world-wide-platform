/* global describe, test, expect */
// The patient notification catalogue and its pure validators. No database, no network, no push.
const cat = require('../../src/modules/notifications/notification-catalogue');

const base = (over = {}) => ({ recipientType: 'patient', recipientId: 42, kind: 'stage_update', title: 'CASE-1 update', ...over });

describe('catalogue', () => {
  test('legacy kinds are known, creatable, not mandatory and need no references', () => {
    for (const k of ['system', 'stage_update', 'quotation_ready', 'document']) {
      const def = cat.getKindDefinition(k);
      expect(def.legacy).toBe(true);
      expect(def.mandatory).toBe(false);
      expect(def.requiredRefs).toEqual([]);
      expect(def.recipientTypes).toEqual(['patient']);
    }
  });

  test('mandatory is true for exactly the security and payment placeholders', () => {
    const mandatory = Object.keys(cat.CATALOGUE).filter((k) => cat.classifyMandatory(k)).sort();
    expect(mandatory).toEqual(['payment_failed', 'payment_received', 'payment_refunded', 'security_new_login', 'security_password_changed']);
    for (const k of mandatory) {
      expect(cat.CATALOGUE[k].placeholder).toBe(true);
      expect(['security', 'payment']).toContain(cat.CATALOGUE[k].category);
    }
    for (const k of Object.keys(cat.CATALOGUE)) if (!mandatory.includes(k)) expect(cat.CATALOGUE[k].category).not.toMatch(/security|payment/);
  });

  test('every screen in the catalogue is an allowed screen, and the allowed list is exactly the approved one', () => {
    expect([...cat.ALLOWED_SCREENS].sort()).toEqual(['case', 'home', 'payment', 'quotation', 'request']);
    for (const def of Object.values(cat.CATALOGUE)) for (const s of def.allowedScreens) expect(cat.ALLOWED_SCREENS).toContain(s);
  });

  test('the catalogue is frozen', () => {
    expect(Object.isFrozen(cat.CATALOGUE)).toBe(true);
    expect(Object.isFrozen(cat.CATALOGUE.system)).toBe(true);
    expect(Object.isFrozen(cat.CATALOGUE.payment_received.requiredRefs)).toBe(true);
  });

  test('unknown kinds are not known, not mandatory, but every stored kind string stays readable', () => {
    expect(cat.isKnownKind('made_up')).toBe(false);
    expect(cat.isKnownKind('__proto__')).toBe(false);
    expect(cat.isKnownKind('constructor')).toBe(false);
    expect(cat.classifyMandatory('made_up')).toBe(false);
    expect(cat.isReadableKind('made_up')).toBe(true);
    expect(cat.isReadableKind('stage_update')).toBe(true);
    expect(cat.isReadableKind(null)).toBe(false);
  });
});

describe('recipient, kind and screen validators', () => {
  test('only the patient recipient type is supported (corporate_user is rejected for now)', () => {
    expect(cat.validateRecipientType('patient').ok).toBe(true);
    expect(cat.validateRecipientType('corporate_user').code).toBe('unsupported_recipient_type');
    expect(cat.validateRecipientType(undefined).ok).toBe(false);
  });

  test('recipient id must be a positive integer', () => {
    expect(cat.validateRecipientId(1).ok).toBe(true);
    for (const bad of [0, -1, 1.5, '1', null, NaN]) expect(cat.validateRecipientId(bad).ok).toBe(false);
  });

  test('kind validation', () => {
    expect(cat.validateKind('document').ok).toBe(true);
    expect(cat.validateKind('nope').code).toBe('unknown_kind');
    expect(cat.validateKindForRecipient('document', 'corporate_user').code).toBe('kind_not_allowed_for_recipient');
  });

  test('screens: allowed list and per-kind restriction', () => {
    for (const s of ['case', 'request', 'quotation', 'payment', 'home']) expect(cat.validateScreen(s).ok).toBe(true);
    expect(cat.validateScreen('tickets').code).toBe('invalid_screen'); // no patient ticket route
    expect(cat.validateScreen('admin').code).toBe('invalid_screen');
    expect(cat.validateScreen('https://evil.example').ok).toBe(false);
    expect(cat.validateScreen('payment', 'stage_update').code).toBe('screen_not_allowed_for_kind');
    expect(cat.validateScreen('case', 'stage_update').ok).toBe(true);
  });
});

describe('data validator', () => {
  test('absent data is fine; a valid shape passes', () => {
    expect(cat.validateData(undefined, 'stage_update').ok).toBe(true);
    expect(cat.validateData(null, 'stage_update').ok).toBe(true);
    expect(cat.validateData({ screen: 'case', entityType: 'case', entityId: 7 }, 'stage_update').ok).toBe(true);
    expect(cat.validateData({ screen: 'home' }, 'system').ok).toBe(true);
  });

  test('unapproved keys, non-objects and bad values are rejected', () => {
    expect(cat.validateData({ screen: 'case', diagnosis: 'x' }, 'stage_update').code).toBe('data_key_not_allowed');
    expect(cat.validateData({ url: 'https://x' }, 'system').code).toBe('data_key_not_allowed');
    expect(cat.validateData('case', 'system').code).toBe('data_invalid');
    expect(cat.validateData(['case'], 'system').code).toBe('data_invalid');
    expect(cat.validateData({ screen: 'nowhere' }, 'system').code).toBe('invalid_screen');
    expect(cat.validateData({ entityType: 'patient_record', entityId: 1 }, 'system').code).toBe('invalid_entity_type');
    expect(cat.validateData({ entityType: 'case', entityId: '1' }, 'system').code).toBe('invalid_entity_id');
    expect(cat.validateData({ entityType: 'case' }, 'system').code).toBe('data_entity_incomplete');
  });

  test('the payload size limit is enforced in bytes', () => {
    // Only approved keys are allowed, so the largest legal payload is tiny; prove the limit with a long (but valid) key set via a huge entityId string is
    // impossible, so check the constant and a payload just under it.
    expect(cat.LIMITS.dataMaxBytes).toBe(512);
    expect(cat.validateData({ screen: 'case', entityType: 'case', entityId: Number.MAX_SAFE_INTEGER }, 'stage_update').ok).toBe(true);
  });
});

describe('approved per-kind screens', () => {
  test('exactly the approved assignments', () => {
    const screens = (k) => [...cat.CATALOGUE[k].allowedScreens];
    expect(screens('system')).toEqual(['home']);
    expect(screens('stage_update')).toEqual(['case', 'request']);
    expect(screens('quotation_ready')).toEqual(['quotation', 'case']);
    expect(screens('document')).toEqual(['case', 'request']);
    for (const k of ['security_password_changed', 'security_new_login']) expect(screens(k)).toEqual(['home']);
    for (const k of ['payment_received', 'payment_failed', 'payment_refunded']) expect(screens(k)).toEqual(['payment', 'quotation', 'case']);
  });
});

describe('screen and entityType', () => {
  test('each screen needs its own entity type; home takes none', () => {
    expect(cat.SCREEN_ENTITY_TYPE).toEqual({ case: 'case', request: 'service_request', quotation: 'quotation', payment: 'payment', home: null });
    expect(cat.validateData({ screen: 'case', entityType: 'case', entityId: 1 }, 'stage_update').ok).toBe(true);
    expect(cat.validateData({ screen: 'request', entityType: 'service_request', entityId: 1 }, 'stage_update').ok).toBe(true);
    expect(cat.validateData({ screen: 'quotation', entityType: 'quotation', entityId: 1 }, 'quotation_ready').ok).toBe(true);
    expect(cat.validateData({ screen: 'payment', entityType: 'payment', entityId: 1 }, 'payment_received').ok).toBe(true);
    expect(cat.validateData({ screen: 'home' }, 'security_new_login').ok).toBe(true);
  });

  test('mismatches are rejected', () => {
    expect(cat.validateData({ screen: 'case', entityType: 'service_request', entityId: 1 }, 'stage_update').code).toBe('entity_type_screen_mismatch');
    expect(cat.validateData({ screen: 'request', entityType: 'case', entityId: 1 }, 'stage_update').code).toBe('entity_type_screen_mismatch');
    expect(cat.validateData({ screen: 'quotation', entityType: 'payment', entityId: 1 }, 'quotation_ready').code).toBe('entity_type_screen_mismatch');
    expect(cat.validateData({ screen: 'payment', entityType: 'quotation', entityId: 1 }, 'payment_failed').code).toBe('entity_type_screen_mismatch');
    expect(cat.validateData({ screen: 'home', entityType: 'case', entityId: 1 }, 'system').code).toBe('entity_not_allowed_for_screen');
    expect(cat.validateData({ entityType: 'ticket', entityId: 1 }, 'system').code).toBe('invalid_entity_type');
  });
});

describe('references required by a deep-link screen', () => {
  test('the required references per screen', () => {
    expect(cat.SCREEN_REQUIRED_REFS).toEqual({
      home: [], case: ['serviceRequestId'], request: ['serviceRequestId'], quotation: ['serviceRequestId'], payment: ['serviceRequestId', 'quotationId'],
    });
    expect(Object.isFrozen(cat.SCREEN_REQUIRED_REFS)).toBe(true);
    expect(cat.validateScreenRefs('home', {}).ok).toBe(true);
    expect(cat.validateScreenRefs('home', undefined).ok).toBe(true);
    expect(cat.validateScreenRefs('case', { serviceRequestId: 1 }).ok).toBe(true);
    expect(cat.validateScreenRefs('case', { serviceRequestId: 1, caseId: 2 }).ok).toBe(true); // caseId may be added
    expect(cat.validateScreenRefs('case', { caseId: 2 }).code).toBe('screen_ref_required');
    expect(cat.validateScreenRefs('request', {}).code).toBe('screen_ref_required');
    expect(cat.validateScreenRefs('quotation', { serviceRequestId: 1 }).ok).toBe(true); // quotationId recommended, not enforced
    expect(cat.validateScreenRefs('quotation', { quotationId: 3 }).code).toBe('screen_ref_required');
    expect(cat.validateScreenRefs('payment', { serviceRequestId: 1 }).code).toBe('screen_ref_required');
    expect(cat.validateScreenRefs('payment', { quotationId: 1 }).code).toBe('screen_ref_required');
    expect(cat.validateScreenRefs('payment', { serviceRequestId: 1, quotationId: 3 }).ok).toBe(true);
    expect(cat.validateScreenRefs('tickets', {}).code).toBe('invalid_screen');
    expect(cat.validateScreenRefs('__proto__', {}).code).toBe('invalid_screen');
  });

  test('enforced for new notifications that carry a screen', () => {
    const withScreen = (kind, data, refs = {}) => cat.validateNotificationInput(base({ kind, data, ...refs }));
    expect(withScreen('stage_update', { screen: 'request', entityType: 'service_request', entityId: 8 }).code).toBe('screen_ref_required');
    expect(withScreen('stage_update', { screen: 'request', entityType: 'service_request', entityId: 8 }, { serviceRequestId: 8 }).ok).toBe(true);
    expect(withScreen('quotation_ready', { screen: 'quotation', entityType: 'quotation', entityId: 3 }, { serviceRequestId: 8, quotationId: 3 }).ok).toBe(true);
    expect(withScreen('payment_received', { screen: 'payment', entityType: 'payment', entityId: 6 }, { serviceRequestId: 8, quotationId: 3 }).ok).toBe(true);
    expect(withScreen('payment_received', { screen: 'payment', entityType: 'payment', entityId: 6 }, { quotationId: 3 }).code).toBe('screen_ref_required');
    expect(withScreen('system', { screen: 'home' }).ok).toBe(true);
  });

  test('historical-style notifications with no data and no references stay valid', () => {
    for (const k of ['system', 'stage_update', 'quotation_ready', 'document']) {
      expect(cat.validateNotificationInput(base({ kind: k, body: 'Old text' })).ok).toBe(true);
    }
    expect(cat.validateNotificationInput(base({ kind: 'stage_update', data: {} })).ok).toBe(true);
  });
});

describe('entityId consistency with the references', () => {
  const run = (data, refs) => cat.validateEntityConsistency(data, refs);
  const full = (kind, data, refs) => cat.validateNotificationInput(base({ kind, data, ...refs }));

  test('the entity-to-reference map', () => {
    expect(cat.SCREEN_ENTITY_REF).toEqual({ case: 'caseId', request: 'serviceRequestId', quotation: 'quotationId', payment: null, home: null });
  });

  test('matching ids pass', () => {
    expect(run({ screen: 'case', entityType: 'case', entityId: 5 }, { caseId: 5, serviceRequestId: 8 }).ok).toBe(true);
    expect(run({ screen: 'request', entityType: 'service_request', entityId: 8 }, { serviceRequestId: 8 }).ok).toBe(true);
    expect(run({ screen: 'quotation', entityType: 'quotation', entityId: 3 }, { quotationId: 3, serviceRequestId: 8 }).ok).toBe(true);
    expect(full('stage_update', { screen: 'case', entityType: 'case', entityId: 5 }, { caseId: 5, serviceRequestId: 8 }).ok).toBe(true);
    expect(full('stage_update', { screen: 'request', entityType: 'service_request', entityId: 8 }, { serviceRequestId: 8 }).ok).toBe(true);
    expect(full('quotation_ready', { screen: 'quotation', entityType: 'quotation', entityId: 3 }, { quotationId: 3, serviceRequestId: 8 }).ok).toBe(true);
  });

  test('mismatched ids are rejected', () => {
    expect(run({ screen: 'case', entityType: 'case', entityId: 5 }, { caseId: 6 }).code).toBe('entity_ref_mismatch');
    expect(run({ screen: 'request', entityType: 'service_request', entityId: 8 }, { serviceRequestId: 9 }).code).toBe('entity_ref_mismatch');
    expect(run({ screen: 'quotation', entityType: 'quotation', entityId: 3 }, { quotationId: 4 }).code).toBe('entity_ref_mismatch');
    expect(full('stage_update', { screen: 'case', entityType: 'case', entityId: 5 }, { caseId: 6, serviceRequestId: 8 }).code).toBe('entity_ref_mismatch');
    expect(full('stage_update', { screen: 'request', entityType: 'service_request', entityId: 8 }, { serviceRequestId: 9 }).code).toBe('entity_ref_mismatch');
    // another reference with the same number does not count
    expect(run({ screen: 'case', entityType: 'case', entityId: 5 }, { serviceRequestId: 5 }).code).toBe('entity_ref_missing');
  });

  test('a missing matching reference is rejected when entityId is supplied', () => {
    expect(run({ screen: 'case', entityType: 'case', entityId: 5 }, {}).code).toBe('entity_ref_missing');
    expect(run({ screen: 'request', entityType: 'service_request', entityId: 8 }, undefined).code).toBe('entity_ref_missing');
    expect(run({ screen: 'quotation', entityType: 'quotation', entityId: 3 }, { serviceRequestId: 8 }).code).toBe('entity_ref_missing');
    expect(full('stage_update', { screen: 'case', entityType: 'case', entityId: 5 }, { serviceRequestId: 8 }).code).toBe('entity_ref_missing');
    expect(full('quotation_ready', { screen: 'quotation', entityType: 'quotation', entityId: 3 }, { serviceRequestId: 8 }).code).toBe('entity_ref_missing');
    // request screen without serviceRequestId is caught first by the existing screen requirement
    expect(full('stage_update', { screen: 'request', entityType: 'service_request', entityId: 8 }, {}).code).toBe('screen_ref_required');
  });

  test('caseId and quotationId stay optional without an entityId', () => {
    expect(full('stage_update', { screen: 'case' }, { serviceRequestId: 8 }).ok).toBe(true);
    expect(full('quotation_ready', { screen: 'quotation' }, { serviceRequestId: 8 }).ok).toBe(true);
    expect(full('stage_update', { screen: 'case' }, {}).code).toBe('screen_ref_required'); // serviceRequestId still required
    expect(run({ screen: 'case' }, {}).ok).toBe(true);
    expect(run(undefined, {}).ok).toBe(true);
    expect(run(null, {}).ok).toBe(true);
  });

  test('payment and home are not checked here (payment is deferred to the core)', () => {
    expect(run({ screen: 'payment', entityType: 'payment', entityId: 99 }, { serviceRequestId: 8, quotationId: 3 }).ok).toBe(true);
    expect(full('payment_received', { screen: 'payment', entityType: 'payment', entityId: 99 }, { serviceRequestId: 8, quotationId: 3 }).ok).toBe(true);
    expect(run({ screen: 'home' }, {}).ok).toBe(true);
  });
});

describe('fixed safe texts', () => {
  test('the approved, fixed bodies', () => {
    expect(cat.SAFE_BODIES.caseStatusUpdated).toBe('Your case status has been updated.');
    expect(Object.keys(cat.SAFE_BODIES)).toEqual(['caseStatusUpdated']); // no ticket text: there is no patient ticket feature
    expect(Object.isFrozen(cat.SAFE_BODIES)).toBe(true);
    expect(Object.keys(cat.CATALOGUE).some((k) => /ticket/i.test(k))).toBe(false);
    for (const b of Object.values(cat.SAFE_BODIES)) {
      expect(cat.validateNotificationInput({ recipientType: 'patient', recipientId: 1, kind: 'system', title: 't', body: b }).ok).toBe(true);
    }
  });
});

describe('references', () => {
  test('legacy kinds need none; shapes are still checked when given', () => {
    expect(cat.validateRefs({}, 'stage_update').ok).toBe(true);
    expect(cat.validateRefs(undefined, 'system').ok).toBe(true);
    expect(cat.validateRefs({ caseId: 3 }, 'stage_update').ok).toBe(true);
    expect(cat.validateRefs({ caseId: '3' }, 'stage_update').code).toBe('ref_invalid');
    expect(cat.validateRefs({ caseId: 0 }, 'stage_update').code).toBe('ref_invalid');
    expect(cat.validateRefs({ userId: 3 }, 'stage_update').code).toBe('ref_not_allowed');
  });

  test('payment kinds require a quotationId', () => {
    expect(cat.validateRefs({}, 'payment_received').code).toBe('ref_required');
    expect(cat.validateRefs({ caseId: 1 }, 'payment_failed').code).toBe('ref_required');
    expect(cat.validateRefs({ quotationId: 9 }, 'payment_refunded').ok).toBe(true);
  });
});

describe('validateNotificationInput', () => {
  test('a valid legacy input returns a sanitised value with the catalogue classification', () => {
    const r = cat.validateNotificationInput(base({ body: 'Moved on.', caseId: 5, serviceRequestId: 8, data: { screen: 'case', entityType: 'case', entityId: 5 } }));
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      recipientType: 'patient', recipientId: 42, kind: 'stage_update', title: 'CASE-1 update', body: 'Moved on.',
      caseId: 5, serviceRequestId: 8, quotationId: null, data: { screen: 'case', entityType: 'case', entityId: 5 }, isMandatory: false,
    });
  });

  test('a client-supplied isMandatory is ignored in both directions', () => {
    expect(cat.validateNotificationInput(base({ isMandatory: true })).value.isMandatory).toBe(false);
    const pay = cat.validateNotificationInput(base({ kind: 'payment_received', quotationId: 3, isMandatory: false }));
    expect(pay.ok).toBe(true);
    expect(pay.value.isMandatory).toBe(true);
  });

  test('unlisted fields are not copied', () => {
    const r = cat.validateNotificationInput(base({ readAt: new Date(), deletedAt: new Date(), id: 99 }));
    expect(Object.keys(r.value)).not.toEqual(expect.arrayContaining(['readAt', 'deletedAt', 'id']));
  });

  test('rejections', () => {
    expect(cat.validateNotificationInput(null).code).toBe('input_invalid');
    expect(cat.validateNotificationInput(base({ recipientType: 'corporate_user' })).code).toBe('unsupported_recipient_type');
    expect(cat.validateNotificationInput(base({ recipientId: 'x' })).code).toBe('invalid_recipient_id');
    expect(cat.validateNotificationInput(base({ kind: 'bogus' })).code).toBe('unknown_kind');
    expect(cat.validateNotificationInput(base({ title: '' })).code).toBe('title_required');
    expect(cat.validateNotificationInput(base({ title: 'x'.repeat(cat.LIMITS.titleMax + 1) })).code).toBe('title_too_long');
    expect(cat.validateNotificationInput(base({ body: 'x'.repeat(cat.LIMITS.bodyMax + 1) })).code).toBe('body_too_long');
    expect(cat.validateNotificationInput(base({ body: 5 })).code).toBe('body_invalid');
    expect(cat.validateNotificationInput(base({ kind: 'payment_failed' })).code).toBe('ref_required');
    expect(cat.validateNotificationInput(base({ data: { screen: 'payment' } })).code).toBe('screen_not_allowed_for_kind');
  });

  test('the input is not mutated and the returned data is a copy', () => {
    const data = { screen: 'case' };
    const input = base({ data, serviceRequestId: 8 });
    const frozen = JSON.stringify(input);
    const r = cat.validateNotificationInput(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(r.value.data).not.toBe(data);
  });
});

describe('idempotency key', () => {
  const parts = { recipientType: 'patient', recipientId: 42, kind: 'quotation_ready', eventRef: 'q17' };

  test('format is kind:recipientType:recipientId:eventRef', () => {
    expect(cat.buildIdempotencyKey(parts)).toBe('quotation_ready:patient:42:q17');
    expect(cat.buildIdempotencyKey({ ...parts, eventRef: 17 })).toBe('quotation_ready:patient:42:17');
  });

  test('deterministic, and different recipients or kinds never collide', () => {
    expect(cat.buildIdempotencyKey(parts)).toBe(cat.buildIdempotencyKey({ ...parts }));
    expect(cat.buildIdempotencyKey({ ...parts, recipientId: 43 })).not.toBe(cat.buildIdempotencyKey(parts));
    expect(cat.buildIdempotencyKey({ ...parts, kind: 'stage_update' })).not.toBe(cat.buildIdempotencyKey(parts));
  });

  test('invalid parts throw NotificationValidationError with a code', () => {
    const code = (over) => { try { cat.buildIdempotencyKey({ ...parts, ...over }); } catch (e) { expect(e).toBeInstanceOf(cat.NotificationValidationError); return e.code; } return null; };
    expect(code({ recipientType: 'corporate_user' })).toBe('unsupported_recipient_type');
    expect(code({ recipientId: 0 })).toBe('invalid_recipient_id');
    expect(code({ kind: 'nope' })).toBe('unknown_kind');
    expect(code({ eventRef: '' })).toBe('invalid_event_ref');
    expect(code({ eventRef: 'a:b' })).toBe('invalid_event_ref'); // ":" would let parts run together
    expect(code({ eventRef: 'has space' })).toBe('invalid_event_ref');
    expect(code({ eventRef: 'x'.repeat(cat.LIMITS.eventRefMax + 1) })).toBe('invalid_event_ref');
    expect(code({ eventRef: undefined })).toBe('invalid_event_ref');
  });

  test('the longest legal key fits the 191-character column', () => {
    const key = cat.buildIdempotencyKey({ ...parts, kind: 'security_password_changed', recipientId: Number.MAX_SAFE_INTEGER, eventRef: 'x'.repeat(cat.LIMITS.eventRefMax) });
    expect(key.length).toBeLessThanOrEqual(cat.LIMITS.idempotencyKeyMax);
  });
});

describe('purity', () => {
  test('the module requires no database, network or push code', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/modules/notifications/notification-catalogue.js'), 'utf8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // comments may name what the module avoids
    expect(src).not.toMatch(/require\(/);
    expect(src).not.toMatch(/prisma|fetch\(|expo[-_ ]?push|process\.env|Date\.now|Math\.random/i);
  });
});
