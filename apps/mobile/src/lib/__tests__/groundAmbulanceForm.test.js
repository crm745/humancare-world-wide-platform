/* global describe, test, expect, __dirname */
// Ground Ambulance (serviceKey "ground"): Step 1 unchanged; Step 2 is Present medical issue (REQUIRED), Care level (optional, multi-select: ICU, Ventilated,
// Tracheostomy, ECMO), Required on board = Oxygen only, Oxygen flow rate (mandatory while Oxygen is on), Reports, Urgency (required). No Patient
// mobility, Cardiac monitor or Ventilator. Every other service, Commercial Air and Private Charter keep their forms.
const fs = require('fs');
const path = require('path');
const {
  presentIssueMissing, COMMERCIAL_AIR_CARE_LEVELS, careLevelOptionsFor, usesCriticalLevels, needsOxygenRate, oxygenLpmProblem, asksPatientMobility, asksEquipment, equipmentOptionsFor,
  draftForService, needsCareLevel, parseOxygenLpm,
} = require('../requestForm');
const { reviewView, fieldsFor } = require('../reviewView');
const { requestService, EQUIPMENT_OPTIONS } = require('../../data/mock');
const { careLevelText } = require('../requestShape');
const { equipmentView, careChips } = require('../requestDetailsView');
const SERVICES = require('../../data/services.json');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const anchors = (source) => [...source.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1]);
const ORIGINAL = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na'];
const ground = (extra = {}) => ({ service: 'ground', equipOxygen: false, oxygenLpm: '', equipCardiac: false, equipVentilator: false, care: [], mobility: '', ...extra });

describe('Step 1 is untouched', () => {
  const step1 = read('app/request/step1.js');
  test('the eight fields, each validated as before', () => {
    expect(anchors(step1)).toEqual(['name', 'age', 'travelType', 'relation', 'deathPlace', 'deathDate', 'country', 'location', 'dest', 'phone', 'date', 'mortalTransfer']);
    for (const check of ["['name', !isValidName(d.name)],", "['country', !draft.country || (charter && !draft.countryIso)],", "['phone', !isValidMobileNumber(draft.phone, draft.cc)],", "['date', !isValidDateString(draft.date)],"]) {
      expect(step1).toContain(check);
    }
  });
  test('Ground is still patient transport on the generic path (no verified cities, no Travel type)', () => {
    expect(needsCareLevel('ground')).toBe(true);
    expect(requestService({ service: 'ground' }, SERVICES)).toEqual({ title: 'Ground Ambulance', key: 'ground' });
    expect(step1).not.toMatch(/airlineMode|needsAirlineMode/);
  });
});

describe('Step 2 for Ground', () => {
  const step2 = read('app/request/step2.js');
  test('the blocks are Condition, Care level, Required on board, Oxygen flow rate, Reports, Urgency (Travel type and Mobility are other services\')', () => {
    expect(anchors(step2)).toEqual(['desc', 'critical', 'oxygen', 'travel', 'care', 'mobility', 'equipment', 'oxygenLpm', 'files', 'urgency']);
    const askTravel = read('lib/requestForm.js').includes('export const needsTravelType = isCommercialAirService;');
    expect(askTravel).toBe(true); // Travel type is Commercial Air's alone
  });
  test('Patient mobility is not asked of Ground (and so is not required); it still is of the other transport services', () => {
    expect(asksPatientMobility('ground')).toBe(false);
    for (const key of ['air', 'privatecharter']) expect(asksPatientMobility(key)).toBe(true);
    expect(step2).toContain("['mobility', askMobility && !singleChoice(mobility)],");
  });
  test('Present medical issue and Urgency are required; Reports are optional', () => {
    expect(step2).toContain("['urgency', !draft.urgency],");
    expect(step2).toContain("['files', needsDocument(draft)],"); // only Private Charter needs a document
    expect(step2).toContain("['desc', presentIssueMissing(draft)],");
    expect(step2).toContain('<FieldHeader title={conditionTitle} required={ground} />');
  });
  test('the issue is the first thing checked, and only Ground requires it (whitespace does not count)', () => {
    expect(step2.indexOf("['desc', presentIssueMissing(draft)]")).toBeLessThan(step2.indexOf("['travel',"));
    expect(presentIssueMissing(ground({ desc: '' }))).toBe(true);
    expect(presentIssueMissing(ground({ desc: '  \n ' }))).toBe(true);
    expect(presentIssueMissing(ground({}))).toBe(true);
    expect(presentIssueMissing(ground({ desc: 'Acute MI' }))).toBe(false);
    for (const service of ['air', 'privatecharter', 'commercialair', 'hospital']) expect(presentIssueMissing({ service, desc: '' })).toBe(false);
  });
  test('Ground is labelled "Present medical issue" on the form, the review page and the details page; the others keep "Condition & diagnosis"', () => {
    expect(t('field_present_issue')).toBe('Present medical issue');
    expect(read('lib/reviewView.js')).toContain("tele || ground ? t('field_present_issue')");
    expect(read('lib/requestDetailsView.js')).toContain("baseKeyOf(request) === 'ground' ? 'field_present_issue' : 'req_condition'");
    expect(step2).toContain("t(mortal ? 'req_details' : charter ? 'req_medical_history' : ground ? 'field_present_issue' : 'req_condition')");
  });
  test('a Ground request never sends Patient mobility', () => {
    const review = read('app/request/review.js');
    expect(review).toContain('...(asksPatientMobility(d.service) ? { mobility: singleChoice(mobilityList(d.mobility)) || undefined } : {}),');
    expect(asksPatientMobility('ground')).toBe(false);
  });
});

describe('Care level', () => {
  test('the four options, in order', () => {
    expect(careLevelOptionsFor('ground', ORIGINAL)).toEqual(['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo']);
    expect(careLevelOptionsFor('ground', ORIGINAL).map(t)).toEqual(['ICU', 'Ventilated', 'Tracheostomy', 'ECMO']);
    expect(careLevelOptionsFor('ground', ORIGINAL)).toEqual(COMMERCIAL_AIR_CARE_LEVELS);
  });
  test('multi-select and optional (only Private Charter requires one)', () => {
    const step2 = read('app/request/step2.js');
    expect(step2).toMatch(/columns=\{2\} label=\{t\('field_care_level'\)\}/);
    expect(step2).toContain("multiple value={draft.care} onChange={(care) => updateDraft({ care })}");
    expect(step2).toContain('{transport && !charter && (');  // Private Charter (revised form) asks no care level: it asks the Critical Level instead
  });
  test('the other services keep the original four, Private Charter included', () => {
    for (const key of ['air', 'privatecharter', 'hospital', 'homecare', 'tele']) expect(careLevelOptionsFor(key, ORIGINAL)).toBe(ORIGINAL);
    expect(usesCriticalLevels('privatecharter')).toBe(false);
  });
  test('the choices are sent as keys, comma-separated, in the order chosen (never as translated labels)', () => {
    const review = read('app/request/review.js');
    expect(review).toContain("usesCriticalLevels(d.service) ? d.care.join(',')");
  });
});

describe('Required on board: Oxygen only', () => {
  test('one switch for Ground; three for the original services', () => {
    expect(equipmentOptionsFor('ground', EQUIPMENT_OPTIONS).map(([field, , label]) => [field, t(label)])).toEqual([['equipOxygen', 'Oxygen']]);
    for (const key of ['air', 'privatecharter', 'hospital']) expect(equipmentOptionsFor(key, EQUIPMENT_OPTIONS)).toBe(EQUIPMENT_OPTIONS);
  });
  test('asksEquipment', () => {
    expect(asksEquipment('ground', 'equipOxygen')).toBe(true);
    expect(asksEquipment('ground', 'equipCardiac')).toBe(false);
    expect(asksEquipment('ground', 'equipVentilator')).toBe(false);
    // Commercial Air is as it was (Oxygen and Cardiac monitor)
    expect(asksEquipment('commercialair', 'equipCardiac')).toBe(true);
    expect(asksEquipment('commercialair', 'equipVentilator')).toBe(false);
    for (const field of ['equipOxygen', 'equipCardiac', 'equipVentilator']) expect(asksEquipment('privatecharter', field)).toBe(true);
  });
  test('the submitted body sends each item only when the service asks it', () => {
    const review = read('app/request/review.js');
    expect(review).toContain("...(asksEquipment(d.service, 'equipCardiac') ? { equipCardiacMonitor: d.equipCardiac } : {}),");
    expect(review).toContain("...(asksEquipment(d.service, 'equipVentilator') ? { equipVentilator: d.equipVentilator } : {}),");
  });
});

describe('Oxygen flow rate', () => {
  test('asked for Ground, with the same limits', () => {
    expect(needsOxygenRate('ground')).toBe(true);
    expect(parseOxygenLpm('4')).toBe(4);
    expect(parseOxygenLpm('15.1')).toBeNull();
  });
  test('Oxygen off: nothing asked, whatever is typed', () => {
    expect(oxygenLpmProblem(ground({ equipOxygen: false }))).toBeNull();
    expect(oxygenLpmProblem(ground({ equipOxygen: false, oxygenLpm: 'abc' }))).toBeNull();
  });
  test('Oxygen on: required when empty, invalid when wrong, fine when valid', () => {
    expect(oxygenLpmProblem(ground({ equipOxygen: true }))).toBe('required');
    expect(oxygenLpmProblem(ground({ equipOxygen: true, oxygenLpm: '0' }))).toBe('invalid');
    expect(oxygenLpmProblem(ground({ equipOxygen: true, oxygenLpm: '20' }))).toBe('invalid');
    expect(oxygenLpmProblem(ground({ equipOxygen: true, oxygenLpm: '2.5' }))).toBeNull();
  });
  test('Private Charter and the older air key are never asked', () => {
    for (const service of ['air', 'privatecharter']) expect(oxygenLpmProblem({ service, equipOxygen: true, oxygenLpm: '' })).toBeNull();
  });
  test('turning Oxygen off clears the value (the shared Step 2 rule), and Continue is blocked while it is missing', () => {
    const step2 = read('app/request/step2.js');
    expect(step2).toContain("updateDraft(field === 'equipOxygen' && !on ? { equipOxygen: false, oxygenLpm: '' } : { [field]: on })");
    expect(step2).toContain("['oxygenLpm', lpmProblem !== null],");
  });
  test('the flow rate is sent as a number only while Oxygen is on, for Ground too', () => {
    expect(read('app/request/review.js')).toContain('...(needsOxygenRate(d.service) && d.equipOxygen ? { equipOxygenLpm: parseOxygenLpm(d.oxygenLpm) } : {}),');
  });
});

describe('swapping the service inside the form', () => {
  const INITIAL = { service: 'air', mobility: '', equipCardiac: false, equipVentilator: false, care: [] };
  test('into Ground: mobility, Cardiac monitor and Ventilator typed for another service are not carried in; Oxygen and the patient are kept', () => {
    const swapped = draftForService({ changingService: true, service: 'privatecharter', mobility: 'bedridden', equipCardiac: true, equipVentilator: true, equipOxygen: true, name: 'Asha', care: ['care_icu'] }, 'ground', INITIAL);
    expect(swapped).toMatchObject({ service: 'ground', mobility: '', equipCardiac: false, equipVentilator: false, equipOxygen: true, name: 'Asha', care: [] });
  });
  test('into Ground with Oxygen already on asks for the flow rate', () => {
    expect(oxygenLpmProblem(draftForService({ changingService: true, service: 'privatecharter', equipOxygen: true }, 'ground', INITIAL))).toBe('required');
  });
  test('between Ground and Commercial Air the critical levels are kept (the same four)', () => {
    expect(draftForService({ changingService: true, service: 'ground', care: ['crit_icu', 'crit_ecmo'] }, 'commercialair', INITIAL).care).toEqual(['crit_icu', 'crit_ecmo']);
  });
});

describe('the review page for Ground', () => {
  const svc = { key: 'ground', title: 'Ground Ambulance' };
  const FILLED = {
    service: 'ground', name: 'Asha Nair', age: '61', gender: 'Female', cc: '+91', phone: '9876543210', country: 'India', location: 'Pune', dest: 'Mumbai', date: '2026-11-20',
    urgency: 'critical_6h', desc: 'Needs monitoring.', care: ['crit_tracheostomy', 'crit_icu'], mobility: 'bedridden', equipOxygen: true, oxygenLpm: '3',
    equipCardiac: true, equipVentilator: true, files: [{ uri: 'file:///x/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 1000 }],
  };
  test('the Medical details: condition, care levels in the order chosen, Oxygen with its flow rate, no mobility, no Cardiac monitor or Ventilator', () => {
    const v = reviewView(FILLED, svc, t);
    expect(v.medical.condition).toBe('Needs monitoring.');
    expect(v.medical.care).toEqual(['Tracheostomy', 'ICU']);
    expect(v.medical.equipment.items).toEqual(['Oxygen (3 LPM)']);
    expect(v.medical.mobility).toBe('');
    expect(v.medical.travel).toBe('');
    expect(v.medical.urgency).toBeTruthy();
    expect(v.documents).toHaveLength(1);
  });
  test('Oxygen off: no equipment row at all', () => {
    expect(reviewView({ ...FILLED, equipOxygen: false }, svc, t).medical.equipment).toBe(null);
  });
  test('the fields it collects: no mobility, Cardiac monitor or Ventilator; the flow rate is a medical field', () => {
    const fields = fieldsFor('ground');
    for (const gone of ['mobility', 'equipCardiac', 'equipVentilator']) expect(fields).not.toHaveProperty(gone);
    expect(fields).toMatchObject({ care: 'medical', equipOxygen: 'medical', oxygenLpm: 'medical', urgency: 'medical' });
  });
  test('the other transport services review as before', () => {
    for (const key of ['privatecharter', 'air']) {
      const v = reviewView({ ...FILLED, service: key }, { key, title: 'x' }, t);
      expect(v.medical.mobility).toBe('Bedridden');
      expect(v.medical.equipment.items).toEqual(['Oxygen', 'Cardiac monitor', 'Ventilator']);
    }
  });
});

describe('historical Ground requests still read as they were', () => {
  test('older care levels, saved as the labels of the language they were made in, show as stored', () => {
    expect(careLevelText('ICU / Critical, Stable / Monitored', t)).toBe('ICU / Critical, Stable / Monitored');
    expect(careLevelText('care_icu,care_stable', t)).toBe('ICU / Critical, Stable / Monitored');
    expect(careChips('ICU / गंभीर, Ambulatory', t)).toEqual(['ICU / गंभीर', 'Ambulatory']);
  });
  test('new ones (keys) read as the four names', () => {
    expect(careChips('crit_icu,crit_ecmo', t)).toEqual(['ICU', 'ECMO']);
  });
  test('an older request with Cardiac monitor and Ventilator still lists them, and Oxygen without a flow rate reads plain', () => {
    expect(equipmentView({ equipOxygen: true, equipOxygenLpm: null, equipCardiacMonitor: true, equipVentilator: true }, t)).toEqual({ items: ['Oxygen', 'Cardiac monitor', 'Ventilator'], none: false });
    expect(equipmentView({ equipOxygen: true, equipOxygenLpm: 4, equipCardiacMonitor: null, equipVentilator: null }, t)).toEqual({ items: ['Oxygen (4 LPM)'], none: false });
  });
});

describe('isolation', () => {
  test('the Private Charter branch of the submit has no Ground or critical-level rule', () => {
    const review = read('app/request/review.js');
    const charterBranch = review.slice(review.indexOf('if (isPrivateCharter(d.service)) {'), review.indexOf('// Every other service keeps the body it has always sent.'));
    expect(charterBranch).not.toMatch(/usesCriticalLevels|asksEquipment|needsOxygenRate|crit_/);
  });
  test('the rules are keyed on the service key "ground" (not on the transport group)', () => {
    const rules = read('lib/requestForm.js');
    expect(rules).toContain("export const isGroundService = (serviceKey) => serviceKey === 'ground';");
    expect(rules).toContain("export const usesCriticalLevels = (serviceKey) => serviceKey === 'commercialair' || isGroundService(serviceKey);");
  });
});
