/* global describe, test, expect, __dirname */
// Commercial Air care level: exactly ICU, Ventilated, Tracheostomy, ECMO. Every other service keeps the original four; Private Charter is untouched.
const fs = require('fs');
const path = require('path');
const { COMMERCIAL_AIR_CARE_LEVELS, usesCriticalLevels, careLevelOptionsFor, draftForService } = require('../requestForm');
const { reviewView } = require('../reviewView');
const { careLevelText } = require('../requestShape');
const { careChips } = require('../requestDetailsView');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key) => (i18n.EN && i18n.EN[key]) || key;
const ORIGINAL = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na'];

describe('the options', () => {
  test('Commercial Air has exactly ICU, Ventilated, Tracheostomy, ECMO, in that order', () => {
    expect(COMMERCIAL_AIR_CARE_LEVELS).toEqual(['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo']);
    expect(COMMERCIAL_AIR_CARE_LEVELS.map(t)).toEqual(['ICU', 'Ventilated', 'Tracheostomy', 'ECMO']);
  });
  test('Commercial Air and Ground use them; everything else (Private Charter included) keeps the original four', () => {
    for (const key of ['commercialair', 'ground']) {
      expect(usesCriticalLevels(key)).toBe(true);
      expect(careLevelOptionsFor(key, ORIGINAL)).toEqual(COMMERCIAL_AIR_CARE_LEVELS);
    }
    for (const key of ['air', 'privatecharter', 'hospital', 'homecare', 'tele', 'marine', 'medvalue', 'mortal']) {
      expect(usesCriticalLevels(key)).toBe(false);
      expect(careLevelOptionsFor(key, ORIGINAL)).toBe(ORIGINAL);
    }
  });
  test('the original labels are untouched', () => {
    expect(ORIGINAL.map(t)).toEqual(['ICU / Critical', 'Stable / Monitored', 'Ambulatory', 'Not Applicable']);
    expect(read('components/ui.js')).toContain("export const CARE_LEVELS = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na'];");
  });
});

describe('swapping the service inside the form', () => {
  const INITIAL = { service: 'air', care: [] };
  test('into Commercial Air: the old answers do not fit, so the care level starts again', () => {
    expect(draftForService({ changingService: true, service: 'air', care: ['care_icu'], name: 'Asha' }, 'commercialair', INITIAL)).toMatchObject({ care: [], name: 'Asha' });
  });
  test('out of Commercial Air: the same', () => {
    expect(draftForService({ changingService: true, service: 'commercialair', care: ['crit_ecmo'] }, 'air', INITIAL).care).toEqual([]);
  });
  test('between Commercial Air and Ground (the same set): kept; Ground to or from the original set starts again', () => {
    expect(draftForService({ changingService: true, service: 'commercialair', care: ['crit_ecmo'] }, 'ground', INITIAL).care).toEqual(['crit_ecmo']);
    expect(draftForService({ changingService: true, service: 'ground', care: ['crit_icu'] }, 'commercialair', INITIAL).care).toEqual(['crit_icu']);
    expect(draftForService({ changingService: true, service: 'ground', care: ['crit_icu'] }, 'privatecharter', INITIAL).care).toEqual([]);
    expect(draftForService({ changingService: true, service: 'privatecharter', care: ['care_icu'] }, 'ground', INITIAL).care).toEqual([]);
  });
  test('between services that share the original set: kept', () => {
    expect(draftForService({ changingService: true, service: 'air', care: ['care_icu'] }, 'privatecharter', INITIAL).care).toEqual(['care_icu']);
  });
});

describe('what is shown', () => {
  const svc = (key) => ({ key, title: 'Medical Escort (Commercial Airlines)' });
  test('the review page lists the chosen levels', () => {
    const v = reviewView({ service: 'commercialair', care: ['crit_icu', 'crit_ecmo'], mobility: 'bedridden', urgency: 'planned', equipOxygen: false, equipCardiac: false, equipVentilator: false, files: [] }, svc('commercialair_stretcher'), t);
    expect(v.medical.care).toEqual(['ICU', 'ECMO']);
  });
  test('a saved request reads the keys as labels, and the original keys as before', () => {
    expect(careLevelText('crit_icu,crit_ventilated', t)).toBe('ICU, Ventilated');
    expect(careLevelText('crit_tracheostomy', t)).toBe('Tracheostomy');
    expect(careLevelText('care_icu,care_stable', t)).toBe('ICU / Critical, Stable / Monitored');
    expect(careChips('crit_icu,crit_ecmo', t)).toEqual(['ICU', 'ECMO']);
  });
});

describe('Step 2 and the submitted body', () => {
  const step2 = read('app/request/step2.js');
  const review = read('app/request/review.js');
  test('Step 2 offers the set that belongs to the service; Not Applicable stays exclusive for the original set only', () => {
    expect(step2).toContain('options={careLevelOptionsFor(draft.service, CARE_LEVELS).map((key) => ({ value: key, label: t(key), exclusive: key === \'care_na\' }))}');
  });
  test('Commercial Air and Ground send the keys; every other service sends the labels as always; the Private Charter branch is unchanged', () => {
    expect(review).toContain("careLevel: transport && d.care.length ? (usesCriticalLevels(d.service) ? d.care.join(',') : d.care.map(t).join(', ')) : undefined,");
    const charterBranch = review.slice(review.indexOf('if (isPrivateCharter(d.service)) {'), review.indexOf('// Every other service keeps the body it has always sent.'));
    expect(charterBranch).not.toMatch(/crit_|usesCriticalLevels/);
  });
  test('the four labels exist', () => {
    for (const key of COMMERCIAL_AIR_CARE_LEVELS) expect(i18n.EN[key]).toBeTruthy();
  });
});
