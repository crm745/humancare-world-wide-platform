/* global describe, it, expect */
const { draftForService, needsCareLevel } = require('../requestForm');

const INITIAL = {
  service: 'air', name: '', age: '', care: [], airlineMode: '', mortalTransfer: '', relation: '', deathPlace: '', deathDate: '',
  mobility: '', equipOxygen: false, equipCardiac: false, equipVentilator: false, urgency: '', desc: '', files: [], changingService: false,
};

describe('needsCareLevel (patient transport)', () => {
  it.each(['air', 'privatecharter', 'commercialair', 'ground'])('%s is patient transport', (key) => expect(needsCareLevel(key)).toBe(true));
  it.each(['hospital', 'homecare', 'tele', 'mortal', 'corporate'])('%s is not', (key) => expect(needsCareLevel(key)).toBe(false));
});

describe('draftForService', () => {
  it('starts an empty form when a request is started fresh', () => {
    const previous = { ...INITIAL, name: 'Old Patient', changingService: false };
    expect(draftForService(previous, 'ground', INITIAL)).toEqual({ ...INITIAL, service: 'ground' });
  });

  it('keeps the patient and medical answers when the service is changed from inside the form', () => {
    const previous = { ...INITIAL, service: 'privatecharter', changingService: true, name: 'Gouri Patil', age: '64', desc: 'Post-angioplasty', urgency: 'urgent_24h', care: ['care_icu', 'care_stable'], mobility: 'bedridden', equipOxygen: true };
    const next = draftForService(previous, 'ground', INITIAL);
    expect(next).toMatchObject({ service: 'ground', name: 'Gouri Patil', age: '64', desc: 'Post-angioplasty', urgency: 'urgent_24h', care: ['care_icu', 'care_stable'], mobility: 'bedridden', equipOxygen: true });
    expect(next.changingService).toBe(false);
  });

  it('clears what belonged only to the previous service', () => {
    const airline = { ...INITIAL, service: 'commercialair', changingService: true, airlineMode: 'stretcher', name: 'A B' };
    expect(draftForService(airline, 'ground', INITIAL).airlineMode).toBe('');
    const mortal = { ...INITIAL, service: 'mortal', changingService: true, mortalTransfer: 'domestic', relation: 'Son', deathPlace: 'Pune', deathDate: '2026-10-20' };
    expect(draftForService(mortal, 'hospital', INITIAL)).toMatchObject({ mortalTransfer: '', relation: '', deathPlace: '', deathDate: '' });
  });

  it('drops care level, mobility and equipment when the new service is not patient transport', () => {
    const previous = { ...INITIAL, service: 'privatecharter', changingService: true, care: ['care_icu'], mobility: 'wheelchair', equipOxygen: true, equipCardiac: true, equipVentilator: true, urgency: 'planned' };
    const next = draftForService(previous, 'hospital', INITIAL);
    expect(next).toMatchObject({ care: [], mobility: '', equipOxygen: false, equipCardiac: false, equipVentilator: false });
    expect(next.urgency).toBe('planned'); // urgency is asked for every service
  });
});

describe('contact number code follows the Country', () => {
  const { pickRequestCountry, pickRequestPhoneCountry } = require('../requestForm');
  const fresh = { country: '', countryIso: '', cc: '+91', phoneCountry: 'IN', ccEdited: false, phone: '8691930716' };
  const apply = (draft, patch) => ({ ...draft, ...patch });

  it('starts on India +91 before a Country is picked', () => {
    expect(fresh).toMatchObject({ phoneCountry: 'IN', cc: '+91', ccEdited: false });
  });

  it('picking UAE sets the code to +971, and India sets it back to +91', () => {
    let draft = apply(fresh, pickRequestCountry(fresh, 'AE'));
    expect(draft).toMatchObject({ country: 'United Arab Emirates', countryIso: 'AE', phoneCountry: 'AE', cc: '+971', ccEdited: false });
    draft = apply(draft, pickRequestCountry(draft, 'IN'));
    expect(draft).toMatchObject({ country: 'India', phoneCountry: 'IN', cc: '+91' });
    draft = apply(draft, pickRequestCountry(draft, 'GB'));
    expect(draft).toMatchObject({ country: 'United Kingdom', phoneCountry: 'GB', cc: '+44' });
  });

  it('keeps the digits already typed: only the code changes', () => {
    const draft = apply(fresh, pickRequestCountry(fresh, 'AE'));
    expect(draft.phone).toBe('8691930716');
  });

  it('never overwrites a code the person picked by hand', () => {
    let draft = apply(fresh, pickRequestPhoneCountry(fresh, 'AE')); // a UAE number for an Indian patient
    expect(draft).toMatchObject({ phoneCountry: 'AE', cc: '+971', ccEdited: true });
    draft = apply(draft, pickRequestCountry(draft, 'IN'));
    expect(draft).toMatchObject({ country: 'India', countryIso: 'IN', phoneCountry: 'AE', cc: '+971', ccEdited: true });
    draft = apply(draft, pickRequestCountry(draft, 'GB'));
    expect(draft).toMatchObject({ country: 'United Kingdom', phoneCountry: 'AE', cc: '+971' });
  });

  it('remembers which country shares a code, not just the code', () => {
    const canada = apply(fresh, pickRequestCountry(fresh, 'CA'));
    const us = apply(fresh, pickRequestCountry(fresh, 'US'));
    expect([canada.cc, us.cc]).toEqual(['+1', '+1']);
    expect([canada.phoneCountry, us.phoneCountry]).toEqual(['CA', 'US']);
    const byHand = apply(fresh, pickRequestPhoneCountry(fresh, 'CA'));
    expect(byHand).toMatchObject({ phoneCountry: 'CA', cc: '+1' });
  });

  it('sends the country as its name and the code as the dial code, as before', () => {
    const draft = apply(fresh, pickRequestCountry(fresh, 'AE'));
    expect(typeof draft.country).toBe('string');
    expect(draft.cc).toMatch(/^\+\d+$/);
    expect(`${draft.cc} ${draft.phone}`).toBe('+971 8691930716');
  });

  it('survives a change of service: the country and code are kept', () => {
    const draft = { ...INITIAL, ...fresh, ...pickRequestCountry(fresh, 'AE'), service: 'privatecharter', changingService: true };
    const next = draftForService(draft, 'ground', INITIAL);
    expect(next).toMatchObject({ country: 'United Arab Emirates', countryIso: 'AE', phoneCountry: 'AE', cc: '+971' });
  });
});
