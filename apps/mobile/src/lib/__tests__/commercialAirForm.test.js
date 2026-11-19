/* global describe, test, expect, __dirname */
// Commercial Air restructuring: Step 1 loses Travel type; Step 2 gains it (mandatory), drops Patient mobility, and Required on board is Oxygen +
// Cardiac monitor only. Care level stays multi-select and optional. Every other service, and Private Charter, keeps its form.
const fs = require('fs');
const path = require('path');
const {
  isCommercialAirService, equipmentOptionsFor, needsTravelType, asksPatientMobility, draftForService, COMMERCIAL_AIR_CARE_LEVELS, TRAVEL_TYPE_LABELS,
} = require('../requestForm');
const { reviewView, fieldsFor } = require('../reviewView');
const { requestService, AIRLINE_MODES, AIRLINE_MODE_LABELS, EQUIPMENT_OPTIONS } = require('../../data/mock');
const SERVICES = require('../../data/services.json');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const anchors = (source) => [...source.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1]);

describe('Step 1', () => {
  const step1 = read('app/request/step1.js');
  test('Travel type is gone from Step 1 (no field, no check, no imports)', () => {
    expect(step1).not.toMatch(/airlineMode|AIRLINE_MODE|needsAirlineMode|field_airline_mode/);
  });
  test('the fields are the eight (plus the Mortal Remains extras, which are not Commercial Air)', () => {
    expect(anchors(step1)).toEqual(['name', 'age', 'relation', 'deathPlace', 'deathDate', 'country', 'location', 'dest', 'phone', 'date', 'mortalTransfer']);
  });
  test('location, date and phone behaviour is still there (country-restricted origin, any-country destination, date picker, country code)', () => {
    expect(step1).toContain('restrictToCountry');
    expect(step1).toContain('<DateField');
    expect(step1).toContain('pickRequestPhoneCountry');
    expect(step1).toContain('pickRequestCountry');
  });
});

describe('Step 2: the order and the fields', () => {
  const step2 = read('app/request/step2.js');
  test('Condition, Travel type, Care level, Mobility (other services), Required on board, Oxygen flow rate, Reports, Urgency, in that order', () => {
    expect(anchors(step2)).toEqual(['desc', 'travel', 'care', 'mobility', 'equipment', 'oxygenLpm', 'files', 'urgency']);
  });
  test('Travel type is required, with the same two options the service key has always carried', () => {
    expect(step2).toContain("['travel', askTravel && !draft.airlineMode],");
    expect(step2).toMatch(/<Anchor id="travel">\s*<FieldHeader title=\{t\('field_airline_mode'\)\} required \/>/);
    expect(AIRLINE_MODES).toEqual(['stretcher', 'wheelchair']);
    // the chips say just Stretcher / Wheelchair; the labels that name the service in the request (below) keep their codes
    expect(AIRLINE_MODES.map((k) => TRAVEL_TYPE_LABELS[k])).toEqual(['Stretcher', 'Wheelchair']);
    expect(step2).toContain('options={AIRLINE_MODES.map((key) => ({ value: key, label: TRAVEL_TYPE_LABELS[key] }))}');
    expect(step2).not.toContain('AIRLINE_MODE_LABELS');
    expect(AIRLINE_MODES.map((k) => AIRLINE_MODE_LABELS[k])).toEqual(['Stretcher (CAS)', 'Wheelchair (CAW)']);
  });
  test('picking either chip sets the same value as before (stretcher / wheelchair), whatever the label says', () => {
    expect(Object.keys(TRAVEL_TYPE_LABELS)).toEqual(AIRLINE_MODES);
    expect(step2).toContain('onChange={(airlineMode) => updateDraft({ airlineMode })}');
  });
  test('Care level is still multi-select, optional (required only for Private Charter), with the four Commercial Air keys', () => {
    expect(step2).toMatch(/columns=\{2\} label=\{t\('field_care_level'\)\}/);
    expect(step2).toContain(": { multiple: true, value: draft.care, onChange: (care) => updateDraft({ care }) })}");
    expect(step2).toContain("['care', charter && draft.care.length !== 1],");
    expect(COMMERCIAL_AIR_CARE_LEVELS).toEqual(['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo']);
  });
  test('Patient mobility is asked of the other transport services, not of Commercial Air or Ground', () => {
    expect(step2).toContain("['mobility', askMobility && !draft.mobility],");
    for (const key of ['commercialair', 'ground']) expect(asksPatientMobility(key)).toBe(false);
    for (const key of ['air', 'privatecharter']) expect(asksPatientMobility(key)).toBe(true);
    for (const key of ['hospital', 'homecare', 'tele', 'marine', 'medvalue', 'mortal']) expect(asksPatientMobility(key)).toBe(false);
  });
  test('the reports and urgency blocks are untouched', () => {
    expect(step2).toContain('<ReportTiles');
    expect(step2).toContain("['urgency', !draft.urgency],");
    expect(step2).toContain("['files', needsDocument(draft)],");
  });
});

describe('Required on board', () => {
  test('Commercial Air: Oxygen and Cardiac monitor only, in that order', () => {
    expect(equipmentOptionsFor('commercialair', EQUIPMENT_OPTIONS).map(([, , label]) => t(label))).toEqual(['Oxygen', 'Cardiac monitor']);
  });
  test('every other service keeps all three, and the list itself is unchanged', () => {
    for (const key of ['air', 'privatecharter', 'hospital']) expect(equipmentOptionsFor(key, EQUIPMENT_OPTIONS)).toBe(EQUIPMENT_OPTIONS);
    expect(EQUIPMENT_OPTIONS.map(([, , label]) => t(label))).toEqual(['Oxygen', 'Cardiac monitor', 'Ventilator']);
  });
  test('Step 2 draws the filtered list (and the last row has no divider)', () => {
    const step2 = read('app/request/step2.js');
    expect(step2).toContain('const equipment = equipmentOptionsFor(draft.service, EQUIPMENT_OPTIONS);');
    expect(step2).toContain('{equipment.map(([field, , labelKey], i) => (');
    expect(step2).toContain('last={i === equipment.length - 1}');
  });
});

describe('swapping the service into Commercial Air', () => {
  const INITIAL = { service: 'air', mobility: '', equipVentilator: false, care: [] };
  test('mobility and Ventilator answers typed for another service are not carried in', () => {
    const swapped = draftForService({ changingService: true, service: 'ground', mobility: 'bedridden', equipVentilator: true, equipOxygen: true, name: 'Asha' }, 'commercialair', INITIAL);
    expect(swapped).toMatchObject({ service: 'commercialair', mobility: '', equipVentilator: false, equipOxygen: true, name: 'Asha' });
  });
  test('between other services nothing changes', () => {
    const swapped = draftForService({ changingService: true, service: 'ground', mobility: 'bedridden', equipVentilator: true }, 'privatecharter', INITIAL);
    expect(swapped).toMatchObject({ mobility: 'bedridden', equipVentilator: true });
  });
  test('the predicates agree', () => {
    expect(isCommercialAirService('commercialair')).toBe(true);
    expect(needsTravelType('commercialair')).toBe(true);
    expect(needsTravelType('privatecharter')).toBe(false);
  });
});

describe('the request that is sent', () => {
  test('Travel type is in the service key and name, for both subtypes', () => {
    expect(requestService({ service: 'commercialair', airlineMode: 'stretcher' }, SERVICES)).toMatchObject({ key: 'commercialair_stretcher' });
    expect(requestService({ service: 'commercialair', airlineMode: 'wheelchair' }, SERVICES)).toMatchObject({ key: 'commercialair_wheelchair' });
    expect(requestService({ service: 'commercialair', airlineMode: 'wheelchair' }, SERVICES).title).toContain('Wheelchair (CAW)');
  });
  test('without a Travel type there is no subtype (the backend refuses that request)', () => {
    expect(requestService({ service: 'commercialair', airlineMode: '' }, SERVICES).key).toBe('commercialair');
  });
  const review = read('app/request/review.js');
  test('Commercial Air and Ground send no mobility; each sends only the on-board items it asks; the other services send them as always', () => {
    expect(review).toContain('...(asksPatientMobility(d.service) ? { mobility: d.mobility } : {}),');
    expect(review).toContain("...(asksEquipment(d.service, 'equipCardiac') ? { equipCardiacMonitor: d.equipCardiac } : {}),");
    expect(review).toContain("...(asksEquipment(d.service, 'equipVentilator') ? { equipVentilator: d.equipVentilator } : {}),");
  });
  test('care levels still go as the comma-separated keys, in the order chosen', () => {
    expect(review).toContain("usesCriticalLevels(d.service) ? d.care.join(',')");
  });
  test('the Private Charter branch has none of these rules', () => {
    const charterBranch = review.slice(review.indexOf('if (isPrivateCharter(d.service)) {'), review.indexOf('// Every other service keeps the body it has always sent.'));
    expect(charterBranch).not.toMatch(/isCommercialAirService|asksPatientMobility|asksEquipment|equipmentOptionsFor/);
  });
});

describe('the review page', () => {
  const FILLED = {
    service: 'commercialair', name: 'Asha Nair', age: '61', gender: 'Female', cc: '+91', phone: '9876543210', country: 'India', location: 'Mumbai, India', dest: 'Dubai, UAE',
    date: '2026-11-20', urgency: 'urgent_24h', desc: 'Post-operative monitoring.', care: ['crit_ecmo', 'crit_icu'], mobility: 'bedridden', equipOxygen: true, oxygenLpm: '4',
    equipCardiac: true, equipVentilator: true, files: [{ uri: 'file:///x/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 1000 }],
  };
  const svc = (key) => ({ key, title: 'Medical Escort (Commercial Airlines)' });

  test.each([['commercialair_stretcher', 'Stretcher'], ['commercialair_wheelchair', 'Wheelchair']])('%s: Patient & Travel details, then the Medical details with Travel type', (key, label) => {
    const v = reviewView({ ...FILLED, airlineMode: key.split('_')[1] }, svc(key), t);
    // Patient & Travel details: the eight (Travel type is not among them)
    expect(v.patient.fields.map((f) => f.key)).toEqual(['name', 'age', 'gender', 'contact', 'country']);
    expect(v.trip.from).toBe('Mumbai, India');
    expect(v.trip.to).toBe('Dubai, UAE');
    expect(v.trip.rows.map((r) => r.key)).toEqual(['date']);
    // Medical details
    expect(v.medical.condition).toBe('Post-operative monitoring.');
    expect(v.medical.travel).toBe(label);
    expect(v.medical.care).toEqual(['ECMO', 'ICU']); // the order chosen
    expect(v.medical.equipment.items).toEqual(['Oxygen (4 LPM)', 'Cardiac monitor']);
    expect(v.medical.mobility).toBe('');
    expect(v.medical.urgency).toBeTruthy();
    expect(v.documents).toHaveLength(1);
    expect(v.show).toMatchObject({ patient: true, trip: true, medical: true, documents: true });
  });

  test('the fields the form collects for Commercial Air have no mobility and no Ventilator, and Travel type is a Medical field', () => {
    const fields = fieldsFor('commercialair_stretcher');
    expect(fields).not.toHaveProperty('mobility');
    expect(fields).not.toHaveProperty('equipVentilator');
    expect(fields).toMatchObject({ airlineMode: 'medical', oxygenLpm: 'medical', equipOxygen: 'medical', equipCardiac: 'medical', care: 'medical' });
  });

  test('other services review exactly as before (mobility, Ventilator, no Travel type)', () => {
    for (const key of ['privatecharter', 'air']) {
      const v = reviewView({ ...FILLED, service: key, airlineMode: '' }, svc(key), t);
      expect(v.medical.mobility).toBe('Bedridden');
      expect(v.medical.equipment.items).toEqual(['Oxygen', 'Cardiac monitor', 'Ventilator']);
      expect(v.medical.travel).toBe('');
    }
  });

  // Mortal Remains' two choices (Transfer Scope, Transport Mode) are patient details now, not a Trip row.
  test('Mortal Remains shows its Transfer Scope and Transport Mode with the patient details, and only the date on the Trip', () => {
    const v = reviewView({ ...FILLED, service: 'mortal', transferScope: 'domestic', transportMode: 'ground_transportation', relation: 'Father', deathPlace: 'Pune', deathDate: '2026-10-01' }, svc('mortal'), t);
    expect(v.trip.rows.map((r) => r.key)).toEqual(['date']);
    expect(v.patient.fields.filter((f) => ['scope', 'mode'].includes(f.key)).map((f) => f.value)).toEqual(['Domestic', 'Ground Transportation']);
  });

  test('Review and Request details say just Stretcher / Wheelchair, in every language (no CAS / CAW code)', () => {
    expect(i18n.EN.rd_travel_stretcher).toBe('Stretcher');
    expect(i18n.EN.rd_travel_wheelchair).toBe('Wheelchair');
    for (const lang of Object.keys(i18n)) {
      for (const key of ['rd_travel_stretcher', 'rd_travel_wheelchair']) {
        expect(i18n[lang][key]).toBeTruthy();
        expect(i18n[lang][key]).not.toMatch(/CAS|CAW|\(|\)/);
      }
    }
  });

  test('the name of the service that is sent with the request keeps its codes (payload unchanged)', () => {
    expect(AIRLINE_MODE_LABELS).toEqual({ stretcher: 'Stretcher (CAS)', wheelchair: 'Wheelchair (CAW)' });
    expect(requestService({ service: 'commercialair', airlineMode: 'stretcher' }, SERVICES).title).toContain('Stretcher (CAS)');
    expect(requestService({ service: 'commercialair', airlineMode: 'wheelchair' }, SERVICES).title).toContain('Wheelchair (CAW)');
  });

  test('the Medical card draws a Travel type row', () => {
    expect(read('components/request/DetailsBlocks.js')).toContain("rows.push(['travel', t('field_airline_mode'),");
  });
});
