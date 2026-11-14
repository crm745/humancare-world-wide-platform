/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');
const i18n = require('../../data/i18n.json');
const { translate } = require('../translate');
const mock = require('../../data/mock');
const V = require('../requestDetailsView');
const { cardView } = require('../myRequestsView');
const { trackingPosition, TRACKING_STEPS } = require('../requestTracking');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const t = (key, values) => translate(i18n, 'EN', key, values);
const tHi = (key, values) => translate(i18n, 'HI', key, values);

// Made-up requests, in the shapes the API returns.
const base = {
  id: 7, referenceNumber: 'REQ-1066', serviceType: 'Home Healthcare', serviceKey: 'homecare', status: 'submitted',
  patientName: 'Asha Rao', patientAge: 64, patientGender: 'Female', patientContact: '+91 9876543210', country: 'India',
  origin: 'Pune, India', destination: 'Mumbai, India', preferredDate: '2026-11-14T00:00:00.000Z', createdAt: '2026-11-13T09:30:00.000Z',
  description: 'Needs a nurse', urgency: 'planned', mobility: null, equipOxygen: null, equipCardiacMonitor: null, equipVentilator: null, careLevel: null, case: null,
};
const charter = {
  ...base, serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientGender: 'male', country: 'IN', patientContact: '+919876543210',
  careLevel: 'care_icu,care_stable', mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: false, equipVentilator: false, urgency: 'critical_6h',
  reviewStatus: 'approved',
};
const caseOf = (status, stages = []) => ({ id: 3, status, stageEvents: stages.map(([stage, occurredAt]) => ({ stage, occurredAt, note: null })), documents: [] });

describe('values that are empty are never shown', () => {
  test.each([null, undefined, '', '   ', 'null', 'undefined'])('%p is nothing', (v) => expect(V.textOf(v)).toBe(''));
  test('a real value is trimmed, and 0 is a value', () => {
    expect(V.textOf('  Pune ')).toBe('Pune');
    expect(V.textOf(0)).toBe('0');
  });
  test('a request with nothing but the required text has no empty rows, and none says null or undefined', () => {
    const view = V.detailsView({ referenceNumber: 'REQ-1', serviceType: 'Telemedicine', serviceKey: 'tele', status: 'submitted', patientName: 'A B', origin: 'X', destination: 'Y', createdAt: '2026-11-13T09:30:00.000Z' }, t);
    const all = JSON.stringify(view);
    expect(all).not.toMatch(/null|undefined|NaN/i.source.replace(/\//g, '') === '' ? /$^/ : /"(null|undefined)"|NaN/);
    expect(view.patient.fields.map((f) => f.key)).toEqual(['name']);
    expect(view.trip.rows).toEqual([]);
    expect(view.medical.urgency).toBeNull();
    expect(view.medical.condition).toBe('');
    expect(view.documents).toEqual([]);
  });
});

describe('gender, country, phone, relation', () => {
  test.each(['Male', 'male', 'MALE', ' male '])('%p reads as the language\'s word', (v) => {
    expect(V.genderLabel(v, t)).toBe('Male');
    expect(V.genderLabel(v, tHi)).toBe(i18n.HI.gender_male);
  });
  test('a gender it does not know is shown as stored', () => expect(V.genderLabel('Non-binary', t)).toBe('Non-binary'));
  test('a country name stays, and an ISO code becomes its name', () => {
    expect(V.countryLabel('India')).toBe('India');
    expect(V.countryLabel('IN')).toBe('India');
    expect(V.countryLabel('ae')).toBe('United Arab Emirates');
    expect(V.countryLabel('')).toBe('');
  });
  test('a phone number is written in international form, from E.164 or the older "+cc number"', () => {
    expect(V.phoneLabel('+919876543210')).toBe('+91 98765 43210');
    expect(V.phoneLabel('+91 9876543210')).toBe('+91 98765 43210');
  });
  test('a phone number that cannot be read is shown as stored', () => {
    expect(V.phoneLabel('+91 123')).toBe('+91 123');
    expect(V.phoneLabel('call me')).toBe('call me');
    expect(V.phoneLabel(null)).toBe('');
  });
  test('relations read in the language, and an unknown one as stored', () => {
    expect(V.relationLabel('Father', tHi)).toBe(i18n.HI.rd_rel_father);
    expect(V.relationLabel('Cousin', t)).toBe('Cousin');
  });
});

describe('dates with no time of day are read in UTC', () => {
  test('the day that was picked, whatever the phone\'s time zone', () => {
    expect(V.formatDateOnly('2026-11-14T00:00:00.000Z', 'en-GB')).toBe('14 Nov 2026');
    expect(V.formatDateOnly('2026-01-01T00:00:00.000Z', 'en-GB')).toBe('01 Jan 2026');
  });
  test('the screen reads them with timeZone UTC', () => expect(read('../requestDetailsView.js')).toContain("timeZone: 'UTC'"));
  test('nothing or an invalid value is empty', () => {
    expect(V.formatDateOnly(null)).toBe('');
    expect(V.formatDateOnly('x')).toBe('');
  });
});

describe('urgency, mobility, equipment, care level', () => {
  test('the three urgencies have the design\'s colours and the app\'s words; critical has the alert icon', () => {
    expect(V.urgencyView('critical_6h', t)).toEqual({ bg: '#FDECEC', fg: '#C53030', alert: true, label: 'Critical · within 6h' });
    expect(V.urgencyView('urgent_24h', t)).toEqual({ bg: '#FDF0DA', fg: '#8F4C08', alert: false, label: 'Urgent · 24h' });
    expect(V.urgencyView('planned', t)).toEqual({ bg: '#EEF1F6', fg: '#5B6B84', alert: false, label: 'Planned' });
  });
  test('an older request with no urgency, or an unknown one, has no chip', () => {
    expect(V.urgencyView(null, t)).toBeNull();
    expect(V.urgencyView('soon', t)).toBeNull();
  });
  test('mobility reads in the language', () => {
    expect(V.mobilityLabel('bedridden', tHi)).toBe(i18n.HI.mobility_bedridden);
    expect(V.mobilityLabel(null, t)).toBe('');
  });
  test('care level is one chip per level: keys are translated, older labels are left as stored', () => {
    expect(V.careChips('care_icu,care_stable', t)).toEqual(['ICU / Critical', 'Stable / Monitored']);
    expect(V.careChips('ICU / Critical, Ambulatory', t)).toEqual(['ICU / Critical', 'Ambulatory']);
    expect(V.careChips('care_icu', tHi)).toEqual([i18n.HI.care_icu]);
    expect(V.careChips(null, t)).toEqual([]);
  });
  test('equipment: a chip for each one that is true; None when all three are false; nothing when none was asked', () => {
    expect(V.equipmentView({ equipOxygen: true, equipCardiacMonitor: true, equipVentilator: false }, t)).toEqual({ items: ['Oxygen', 'Cardiac monitor'], none: false });
    expect(V.equipmentView({ equipOxygen: false, equipCardiacMonitor: false, equipVentilator: false }, t)).toEqual({ items: [], none: true });
    expect(V.equipmentView({ equipOxygen: null, equipCardiacMonitor: null, equipVentilator: null }, t)).toBeNull();
    expect(V.equipmentView({}, t)).toBeNull();
    expect(V.equipmentView({ equipOxygen: true, equipCardiacMonitor: null, equipVentilator: null }, t)).toEqual({ items: ['Oxygen'], none: false });
  });
});

describe('the condition is clamped to four lines only when it is longer', () => {
  test('21 px lines: up to four lines is not long, five is', () => {
    expect(V.needsClamp(84, 21)).toBe(false);
    expect(V.needsClamp(63, 21)).toBe(false);
    expect(V.needsClamp(105, 21)).toBe(true);
    expect(V.needsClamp(0, 21)).toBe(false);
    expect(V.needsClamp(NaN, 21)).toBe(false);
  });
});

describe('the service, its base name, and the travel and transfer type', () => {
  test('the name has no suffix, and the type comes from the key', () => {
    const stretcher = { ...base, serviceKey: 'commercialair_stretcher', serviceType: 'Commercial Airlines — Stretcher (CAS)' };
    const wheel = { ...stretcher, serviceKey: 'commercialair_wheelchair', serviceType: 'Commercial Airlines — Wheelchair (CAW)' };
    const mortal = { ...base, serviceKey: 'mortal_international', serviceType: 'Mortal Remains — International' };
    expect(V.baseServiceName(stretcher, t)).toBe('Commercial Airlines');
    expect(V.baseServiceName(mortal, t)).not.toMatch(/—/);
    expect(t(V.travelTypeKey(stretcher))).toBe('Stretcher (CAS)');
    expect(t(V.travelTypeKey(wheel))).toBe('Wheelchair (CAW)');
    expect(t(V.transferTypeKey(mortal))).toBe('International');
    expect(t(V.transferTypeKey({ ...mortal, serviceKey: 'mortal_domestic' }))).toBe('Within India');
    expect(V.travelTypeKey(base)).toBeNull();
    expect(V.transferTypeKey(base)).toBeNull();
    expect(V.travelTypeKey({ ...stretcher, serviceKey: 'commercialair' })).toBeNull();
  });
  test('Private Charter keeps its full name; an older request with no key falls back to the title', () => {
    expect(V.baseServiceName(charter, t)).toBe('Private Charter Air Ambulance Service');
    expect(V.baseServiceName({ serviceType: 'Home Healthcare — Something' }, t)).toBeTruthy();
  });
  test('the travel and transfer labels in i18n equal the constants the form sends (English)', () => {
    expect(i18n.EN.rd_travel_stretcher).toBe(mock.AIRLINE_MODE_LABELS.stretcher);
    expect(i18n.EN.rd_travel_wheelchair).toBe(mock.AIRLINE_MODE_LABELS.wheelchair);
    expect(i18n.EN.rd_transfer_domestic).toBe(mock.MORTAL_TRANSFER_LABELS.domestic);
    expect(i18n.EN.rd_transfer_international).toBe(mock.MORTAL_TRANSFER_LABELS.international);
    for (const rel of mock.DECEASED_RELATIONS) expect(i18n.EN[`rd_rel_${rel.toLowerCase()}`]).toBe(rel);
    for (const g of mock.GENDER_OPTIONS) expect(i18n.EN[`gender_${g}`]).toBeTruthy();
  });
  test('the constants stay in mock.js for the form and the request body', () => {
    expect(mock.AIRLINE_MODE_LABELS).toEqual({ stretcher: 'Stretcher (CAS)', wheelchair: 'Wheelchair (CAW)' });
    expect(mock.MORTAL_TRANSFER_LABELS).toEqual({ domestic: 'Within India', international: 'International' });
    expect(mock.DECEASED_RELATIONS).toHaveLength(9);
  });
  test('transport is air and ground only', () => {
    for (const key of ['privatecharter', 'air', 'commercialair_stretcher', 'ground']) expect(V.isTransportRequest({ serviceKey: key })).toBe(true);
    for (const key of ['hospital', 'homecare', 'tele', 'corporate', 'marine', 'medvalue', 'mortal_domestic', 'mortal', undefined]) expect(V.isTransportRequest({ serviceKey: key })).toBe(false);
  });
});

describe('the status badge matches My Requests', () => {
  test.each(['submitted', 'in_progress', 'completed', 'cancelled'])('%s has My Requests\' colours and words', (status) => {
    const mine = cardView({ id: 'REQ-1', display: '', status: status === 'in_progress' ? 'progress' : status, rawStatus: status, serviceKey: 'homecare', serviceType: 'Home Healthcare', origin: '', destination: '' }, t);
    const badge = V.statusBadge({ status }, t);
    expect(badge.bg).toBe(mine.badge.bg);
    expect(badge.fg).toBe(mine.badge.fg);
    expect(badge.label).toBe(mine.statusLabel);
  });
});

describe('the status card: exactly one state', () => {
  test('active only for a Case that is scheduled or in progress', () => {
    expect(V.isCaseActive({ case: caseOf('scheduled') })).toBe(true);
    expect(V.isCaseActive({ case: caseOf('in_progress') })).toBe(true);
    for (const s of ['submitted', 'completed', 'cancelled', undefined]) expect(V.isCaseActive({ case: caseOf(s) })).toBe(false);
    expect(V.isCaseActive({ case: null })).toBe(false);
    expect(V.isCaseActive({})).toBe(false);
    expect(V.isCaseActive(null)).toBe(false);
  });
  test('an active case shows the step and stage the Tracking screen shows, and the latest update', () => {
    const request = { ...base, status: 'in_progress', case: caseOf('in_progress', [['submitted', '2026-11-13T09:30:00.000Z'], ['in_progress', '2026-11-14T08:15:00.000Z']]) };
    const card = V.statusCard(request);
    const pos = trackingPosition(request);
    expect(card.kind).toBe('active');
    expect(card.step).toBe(pos.index + 1);
    expect(card.step).toBe(4);
    expect(card.total).toBe(5);
    expect(card.stageKey).toBe(TRACKING_STEPS[pos.index].title);
    expect(card.updated).toMatch(/14 Nov, \d\d:\d\d/);
  });
  test('a scheduled case reads as the same step the Tracking screen gives it (the request status is in progress)', () => {
    const request = { ...base, status: 'in_progress', case: caseOf('scheduled') };
    expect(V.statusCard(request).step).toBe(trackingPosition(request).index + 1);
  });
  test('no case, or a submitted case: no status card at all', () => {
    expect(V.statusCard(base).kind).toBe('none');
    expect(V.statusCard({ ...base, case: caseOf('submitted') }).kind).toBe('none');
  });
  test('a Charter request still in review shows its banner instead, never both', () => {
    for (const reviewStatus of ['awaiting_documents', 'changes_requested', 'in_review']) {
      const card = V.statusCard({ ...charter, reviewStatus, case: null });
      expect(card.kind).toBe('review');
      expect(card.banner.key).toBe(reviewStatus);
    }
  });
  test('approved but the case has not started: "Request approved", not under review', () => {
    expect(V.statusCard({ ...charter, reviewStatus: 'approved', case: caseOf('submitted') }).kind).toBe('approved');
    expect(V.statusCard({ ...charter, reviewStatus: 'approved', case: null }).kind).toBe('approved');
    expect(V.detailsView({ ...charter, reviewStatus: 'approved', case: caseOf('submitted') }, t).showTrackingBar).toBe(false);
  });
  test('approved and the case under way is live tracking', () => {
    expect(V.statusCard({ ...charter, status: 'in_progress', case: caseOf('in_progress') }).kind).toBe('active');
  });
  test('completed names the day of the completed stage, and drops the date when there is none', () => {
    const done = V.statusCard({ ...base, status: 'completed', case: caseOf('completed', [['completed', '2026-11-20T10:00:00.000Z']]) });
    expect(done).toEqual({ kind: 'completed', date: '20 Nov 2026' });
    expect(V.statusCard({ ...base, status: 'completed', case: null })).toEqual({ kind: 'completed', date: '' });
  });
  test('cancelled, whatever the review status', () => {
    expect(V.statusCard({ ...charter, status: 'cancelled', reviewStatus: 'in_review' }).kind).toBe('cancelled');
    expect(V.statusCard({ ...base, status: 'cancelled', case: caseOf('in_progress') }).kind).toBe('cancelled');
  });
  test('the bottom bar is only for a live case', () => {
    expect(V.detailsView({ ...base, status: 'in_progress', case: caseOf('in_progress') }, t).showTrackingBar).toBe(true);
    expect(V.detailsView(base, t).showTrackingBar).toBe(false);
    expect(V.detailsView({ ...base, status: 'completed', case: caseOf('completed') }, t).showTrackingBar).toBe(false);
    expect(V.detailsView({ ...base, status: 'cancelled', case: caseOf('cancelled') }, t).showTrackingBar).toBe(false);
  });
});

describe('the whole screen model', () => {
  test('a homecare request has no transport rows, even if the server sent some', () => {
    const view = V.detailsView({ ...base, careLevel: 'care_icu', mobility: 'walking', equipOxygen: true }, t);
    expect(view.medical.care).toEqual([]);
    expect(view.medical.mobility).toBe('');
    expect(view.medical.equipment).toBeNull();
    expect(view.medical.urgency.label).toBe('Planned');
    expect(view.medical.condition).toBe('Needs a nurse');
  });
  test('a Private Charter request shows everything', () => {
    const view = V.detailsView(charter, t);
    expect(view.patient.fields.map((f) => [f.key, f.value])).toEqual([
      ['name', 'Asha Rao'], ['age', '64'], ['gender', 'Male'], ['country', 'India'], ['contact', '+91 98765 43210'],
    ]);
    expect(view.patient.fields.find((f) => f.key === 'name').full).toBe(true);
    expect(view.medical.care).toEqual(['ICU / Critical', 'Stable / Monitored']);
    expect(view.medical.mobility).toBe('Bedridden');
    expect(view.medical.equipment.items).toEqual(['Oxygen']);
    expect(view.trip.rows).toEqual([{ key: 'date', label: 'Date of service', value: '14 Nov 2026', full: false }]);
  });
  test('Mortal Remains: the deceased, the relation, the place and day of death, the transfer date and type', () => {
    const mortal = { ...base, serviceKey: 'mortal_international', serviceType: 'Mortal Remains — International', deceasedRelation: 'Son', placeOfDeath: 'Dubai Hospital, Dubai', dateOfDeath: '2026-11-10T00:00:00.000Z' };
    const view = V.detailsView(mortal, t);
    expect(view.patient.titleKey).toBe('rd_deceased');
    expect(view.patient.fields.find((f) => f.key === 'name').label).toBe('Deceased Name');
    expect(view.patient.fields.filter((f) => ['relation', 'deathPlace', 'deathDate'].includes(f.key)).map((f) => [f.value, f.full])).toEqual([['Son', true], ['Dubai Hospital, Dubai', true], ['10 Nov 2026', true]]);
    expect(view.trip.rows.map((r) => r.label)).toEqual(['Preferred transfer date', 'Transfer Type']);
    expect(view.medical.conditionLabel).toBe('Details');
  });
  test('Commercial Airlines adds the travel type to the trip', () => {
    const view = V.detailsView({ ...base, serviceKey: 'commercialair_wheelchair', serviceType: 'Commercial Airlines — Wheelchair (CAW)', mobility: 'wheelchair' }, t);
    expect(view.trip.rows.map((r) => r.value)).toEqual(['14 Nov 2026', 'Wheelchair (CAW)']);
  });
  test('an older request with no mobility, equipment or urgency still builds', () => {
    const view = V.detailsView({ ...charter, mobility: null, equipOxygen: null, equipCardiacMonitor: null, equipVentilator: null, urgency: null, careLevel: null, description: null }, t);
    expect(view.medical).toMatchObject({ urgency: null, condition: '', care: [], mobility: '', equipment: null });
  });
  test('long text is passed through whole', () => {
    const long = 'x'.repeat(400);
    const address = 'A'.repeat(150);
    const view = V.detailsView({ ...base, description: long, origin: address }, t);
    expect(view.medical.condition).toHaveLength(400);
    expect(view.trip.from).toHaveLength(150);
  });
});

describe('documents', () => {
  const caseDocs = { ...base, case: { ...caseOf('submitted'), documents: [
    { id: 1, type: 'Medical Report', name: 'discharge-summary.pdf', fileSizeBytes: 1258291, uploadedAt: '2026-11-13T09:30:00.000Z' },
    { id: 2, type: 'Medical Report', name: 'scan.PNG', fileSizeBytes: 655360, uploadedAt: '2026-11-13T09:31:00.000Z' },
    { id: 3, type: 'Death Certificate', name: 'certificate', fileSizeBytes: null, uploadedAt: null },
  ] } };
  test('every case document is a row that opens, with type, extension, size and date', () => {
    const rows = V.documentRows(caseDocs, t);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: 1, openable: true, isImage: false, ext: 'PDF', meta: 'Medical Report · PDF · 1.2 MB · 13 Nov' });
    expect(rows[1]).toMatchObject({ openable: true, isImage: true, ext: 'PNG', meta: 'Medical Report · PNG · 640 KB · 13 Nov' });
    expect(rows[2].meta).toBe('Death Certificate');
  });
  test('a review-workflow request lists only its current documents, display-only, with status and reason', () => {
    const request = { ...charter, reviewStatus: 'changes_requested', requestDocuments: [
      { id: 1, originalName: 'old.pdf', sizeBytes: 100, uploadedAt: '2026-11-12T08:00:00.000Z', replacesId: null, supersededAt: '2026-11-13T08:00:00.000Z', scanStatus: 'clean', reviewStatus: 'rejected', rejectionReason: 'Blurred' },
      { id: 2, originalName: 'new.jpg', sizeBytes: 2048, uploadedAt: '2026-11-13T08:00:00.000Z', replacesId: 1, supersededAt: null, scanStatus: 'clean', reviewStatus: 'rejected', rejectionReason: 'Too dark' },
    ] };
    const rows = V.documentRows(request, t);
    expect(rows.map((r) => r.name)).toEqual(['new.jpg']);
    expect(rows[0]).toMatchObject({ openable: false, isImage: true, status: 'rejected', reason: 'Too dark' });
  });
  test('an extension is read from the end of the name only', () => {
    expect(V.extOf('a.b.pdf')).toBe('pdf');
    expect(V.extOf('noext')).toBe('');
    expect(V.extOf(null)).toBe('');
  });
});

describe('the i18n keys', () => {
  const used = [...new Set(read('../requestDetailsView.js').match(/rd_[a-z_]+/g) || [])]
    .concat([...new Set((read('../../app/request-details.js') + read('../../components/request/ReviewBanner.js')).match(/'(rd_[a-z_]+)'/g) || [])].map((s) => s.replace(/'/g, '')));
  test('every rd_ key the screen uses exists in all six languages', () => {
    for (const key of used.filter((k) => !k.endsWith('_'))) for (const lang of Object.keys(i18n)) expect(typeof i18n[lang][key]).toBe('string');
  });
  test('the keys built from a value exist for every value', () => {
    for (const lang of Object.keys(i18n)) {
      for (const k of ['rd_rel_father', 'rd_rel_other', 'rd_travel_stretcher', 'rd_travel_wheelchair', 'rd_transfer_domestic', 'rd_transfer_international']) expect(i18n[lang][k]).toBeTruthy();
    }
  });
  test('placeholders are the same in every language', () => {
    const holes = (s) => (s.match(/\{\{\s*\w+\s*\}\}/g) || []).map((x) => x.replace(/\s/g, '')).sort().join();
    for (const key of Object.keys(i18n.EN).filter((k) => k.startsWith('rd_'))) for (const lang of Object.keys(i18n)) expect(holes(i18n[lang][key])).toBe(holes(i18n.EN[key]));
  });
  test('the approved state says what the design says', () => {
    expect(i18n.EN.rd_approved_title).toBe('Request approved');
    expect(i18n.EN.rd_approved_text).toBe('Your case is being set up. Live tracking turns on here once our team starts work.');
    expect(read('../../app/request-details.js')).not.toContain('Under medical review');
  });
});
