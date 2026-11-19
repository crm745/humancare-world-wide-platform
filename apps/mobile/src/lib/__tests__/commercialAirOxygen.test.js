/* global describe, test, expect, __dirname */
// Commercial Air: the oxygen flow rate (LPM) under "Required on board". The pure rules, the draft, the review page, the request details,
// the submitted body and the Step 2 wiring. (The screens themselves are not rendered here: this project's Jest covers lib/ logic and reads
// screen source, see jest.config.js. The behaviour on a phone is checked by hand.)
const fs = require('fs');
const path = require('path');
const {
  OXYGEN_LPM_MAX, needsOxygenRate, parseOxygenLpm, isValidOxygenLpm, oxygenLpmProblem, draftForService, needsCareLevel,
} = require('../requestForm');
const { reviewView } = require('../reviewView');
const { equipmentView } = require('../requestDetailsView');
const { buildPrivateCharterPayload } = require('../privateCharter');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};

const commercial = (extra = {}) => ({ service: 'commercialair', airlineMode: 'stretcher', equipOxygen: false, oxygenLpm: '', equipCardiac: false, equipVentilator: false, ...extra });

describe('which service asks for the flow rate', () => {
  test('Commercial Air and Ground only (never Private Charter, the older air key or any other service)', () => {
    expect(needsOxygenRate('commercialair')).toBe(true);
    expect(needsOxygenRate('ground')).toBe(true);
    for (const key of ['air', 'privatecharter', 'hospital', 'homecare', 'tele', 'marine', 'medvalue', 'mortal', 'corporate']) expect(needsOxygenRate(key)).toBe(false);
  });
});

describe('what is an acceptable flow rate', () => {
  test.each([['4', 4], ['2.5', 2.5], ['0.5', 0.5], ['15', 15], [' 6 ', 6], ['0,5', 0.5], ['2,5', 2.5], ['04', 4], [3, 3]])('%p is %p LPM', (text, value) => {
    expect(parseOxygenLpm(text)).toBe(value);
    expect(isValidOxygenLpm(text)).toBe(true);
  });

  test.each([[''], ['  '], [null], [undefined], ['0'], ['0.0'], ['-2'], ['abc'], ['4x'], ['2.55'], ['16'], ['15.1'], ['100'], ['1e1'], ['.5'], ['4.'], ['2..5'], ['1,000']])('%p is refused', (text) => {
    expect(parseOxygenLpm(text)).toBeNull();
    expect(isValidOxygenLpm(text)).toBe(false);
  });

  test("the upper limit is the backend's (15)", () => {
    expect(OXYGEN_LPM_MAX).toBe(15);
    const backend = fs.readFileSync(path.join(__dirname, '../../../../../backend/src/common/constants/request.constants.js'), 'utf8');
    expect(backend).toContain(`const OXYGEN_LPM_MAX = ${OXYGEN_LPM_MAX};`);
  });
});

describe('the problem the form reports', () => {
  test('Oxygen off: nothing is asked, whatever is typed', () => {
    expect(oxygenLpmProblem(commercial({ equipOxygen: false }))).toBeNull();
    expect(oxygenLpmProblem(commercial({ equipOxygen: false, oxygenLpm: 'abc' }))).toBeNull();
  });
  test('Oxygen on: required when empty, invalid when wrong, fine when valid', () => {
    expect(oxygenLpmProblem(commercial({ equipOxygen: true }))).toBe('required');
    expect(oxygenLpmProblem(commercial({ equipOxygen: true, oxygenLpm: '   ' }))).toBe('required');
    expect(oxygenLpmProblem(commercial({ equipOxygen: true, oxygenLpm: '0' }))).toBe('invalid');
    expect(oxygenLpmProblem(commercial({ equipOxygen: true, oxygenLpm: '20' }))).toBe('invalid');
    expect(oxygenLpmProblem(commercial({ equipOxygen: true, oxygenLpm: '4' }))).toBeNull();
  });
  test('Stretcher and Wheelchair are both Commercial Air: the same rule', () => {
    for (const airlineMode of ['stretcher', 'wheelchair']) {
      expect(oxygenLpmProblem(commercial({ airlineMode, equipOxygen: true }))).toBe('required');
      expect(oxygenLpmProblem(commercial({ airlineMode, equipOxygen: true, oxygenLpm: '3' }))).toBeNull();
    }
  });
  test('another service is never asked, even with Oxygen on', () => {
    for (const service of ['air', 'privatecharter']) expect(oxygenLpmProblem({ service, equipOxygen: true, oxygenLpm: '' })).toBeNull();
  });
});

describe('the draft', () => {
  const INITIAL = { service: 'air', equipOxygen: false, oxygenLpm: '' };
  test('starting a request fresh gives an empty flow rate', () => {
    expect(draftForService({ changingService: false }, 'commercialair', INITIAL).oxygenLpm).toBe('');
  });
  test('swapping the service away from Commercial Air clears the flow rate (the other services never take it), and keeps the Oxygen answer', () => {
    const swapped = draftForService({ changingService: true, service: 'commercialair', equipOxygen: true, oxygenLpm: '4', name: 'Asha' }, 'ground', INITIAL);
    expect(swapped).toMatchObject({ service: 'ground', oxygenLpm: '', equipOxygen: true, name: 'Asha' });
    expect(needsCareLevel('ground')).toBe(true);
  });
  test('swapping into Commercial Air with Oxygen already on asks for the flow rate', () => {
    const swapped = draftForService({ changingService: true, service: 'ground', equipOxygen: true, oxygenLpm: '' }, 'commercialair', INITIAL);
    expect(oxygenLpmProblem(swapped)).toBe('required');
  });
  test('the draft has the new key, empty', () => {
    expect(read('state/AppContext.js')).toMatch(/INITIAL_DRAFT = \{[\s\S]*?oxygenLpm: '',/);
  });
});

describe('the review page', () => {
  const svc = (key) => ({ key, title: 'Medical Escort (Commercial Airlines)' });
  const filled = commercial({ equipOxygen: true, oxygenLpm: '4', mobility: 'bedridden', urgency: 'urgent_24h' });

  test.each(['commercialair_stretcher', 'commercialair_wheelchair'])('%s: Oxygen shows its flow rate', (key) => {
    expect(reviewView(filled, svc(key), t).medical.equipment.items).toEqual(['Oxygen (4 LPM)']);
  });
  test('Cardiac monitor follows Oxygen; the Ventilator is no longer a Required-on-board item for Commercial Air (it is the care level "Ventilated")', () => {
    const v = reviewView({ ...filled, equipCardiac: true, equipVentilator: true, oxygenLpm: '2.5' }, svc('commercialair_stretcher'), t);
    expect(v.medical.equipment.items).toEqual(['Oxygen (2.5 LPM)', 'Cardiac monitor']);
  });
  test('Oxygen off: no Oxygen and no flow rate, even if one is left in the draft', () => {
    const v = reviewView({ ...filled, equipOxygen: false, equipCardiac: true }, svc('commercialair_stretcher'), t);
    expect(v.medical.equipment.items).toEqual(['Cardiac monitor']);
  });
  test('any other service shows plain Oxygen', () => {
    for (const key of ['privatecharter', 'air']) {
      expect(reviewView({ ...filled, service: key }, svc(key), t).medical.equipment.items).toEqual(['Oxygen']);
    }
  });
});

describe('request details (what the server saved)', () => {
  test('the flow rate follows Oxygen', () => {
    expect(equipmentView({ equipOxygen: true, equipOxygenLpm: 4, equipCardiacMonitor: false, equipVentilator: false }, t)).toEqual({ items: ['Oxygen (4 LPM)'], none: false });
    expect(equipmentView({ equipOxygen: true, equipOxygenLpm: 2.5, equipCardiacMonitor: true, equipVentilator: false }, t).items).toEqual(['Oxygen (2.5 LPM)', 'Cardiac monitor']);
  });
  test('older requests and other services (no flow rate) show plain Oxygen, exactly as before', () => {
    for (const lpm of [undefined, null]) {
      expect(equipmentView({ equipOxygen: true, equipOxygenLpm: lpm, equipCardiacMonitor: false, equipVentilator: false }, t)).toEqual({ items: ['Oxygen'], none: false });
    }
  });
  test('Oxygen off: nothing about oxygen', () => {
    expect(equipmentView({ equipOxygen: false, equipOxygenLpm: null, equipCardiacMonitor: false, equipVentilator: false }, t)).toEqual({ items: [], none: true });
  });
});

describe('the submitted body (review.js)', () => {
  const review = read('app/request/review.js');
  test('the flow rate is sent as a number, only for Commercial Air and only while Oxygen is on', () => {
    expect(review).toContain('...(needsOxygenRate(d.service) && d.equipOxygen ? { equipOxygenLpm: parseOxygenLpm(d.oxygenLpm) } : {}),');
  });
  test('it is inside the "every other service" body, never the Private Charter one', () => {
    const charterBranch = review.slice(review.indexOf('if (isPrivateCharter(d.service)) {'), review.indexOf('// Every other service keeps the body it has always sent.'));
    expect(charterBranch).not.toMatch(/oxygen/i);
  });
  test('the Private Charter payload is untouched: it never carries a flow rate', () => {
    const draft = { service: 'privatecharter', name: 'Asha Nair', age: '61', gender: 'Female', cc: '+91', phone: '9876543210', countryIso: 'IN', equipOxygen: true, oxygenLpm: '4', care: [], files: [] };
    const payload = buildPrivateCharterPayload(draft);
    expect(Object.keys(payload).filter((k) => /lpm/i.test(k))).toEqual([]);
    expect(payload.equipOxygen).toBe(true);
  });
});

describe('Step 2', () => {
  const step2 = read('app/request/step2.js');
  test('the flow rate is asked only for Commercial Air with Oxygen on, and is a required field', () => {
    expect(step2).toContain('const askLpm = needsOxygenRate(draft.service) && draft.equipOxygen;');
    expect(step2).toMatch(/\{askLpm && \(\s*<Anchor id="oxygenLpm">[\s\S]*?required label=\{t\('req_oxygen_lpm'\)\}/);
  });
  test('turning Oxygen off clears the value; the other two switches are untouched', () => {
    expect(step2).toContain("updateDraft(field === 'equipOxygen' && !on ? { equipOxygen: false, oxygenLpm: '' } : { [field]: on })");
  });
  test('Continue is blocked while the flow rate is missing or invalid, in page order (after the other medical answers, before the reports)', () => {
    expect(step2).toMatch(/\['mobility', askMobility && !draft\.mobility\],\n\s*\['oxygenLpm', lpmProblem !== null\],\n\s*\['files', needsDocument\(draft\)\],/);
  });
  test('only numbers and a decimal point are accepted while typing', () => {
    expect(step2).toContain("text.replace(/[^0-9.,]/g, '')");
    expect(step2).toContain('keyboardType="decimal-pad"');
  });
  test('Required on board still has exactly Oxygen, Cardiac monitor and Ventilator', () => {
    expect(read('data/mock.js')).toMatch(/EQUIPMENT_OPTIONS = \[\s*\['equipOxygen', 'equipOxygen', 'equip_oxygen'\],\s*\['equipCardiac', 'equipCardiacMonitor', 'equip_cardiac_monitor'\],\s*\['equipVentilator', 'equipVentilator', 'equip_ventilator'\],\s*\];/);
  });
  test('the words exist (English; the other languages fall back to it like their other missing keys)', () => {
    for (const key of ['equip_oxygen_lpm', 'req_oxygen_lpm', 'req_oxygen_lpm_placeholder', 'req_oxygen_lpm_required', 'req_oxygen_lpm_invalid']) expect(i18n.EN[key]).toBeTruthy();
    expect(i18n.EN.req_oxygen_lpm_invalid).toContain('{{max}}');
  });
});
