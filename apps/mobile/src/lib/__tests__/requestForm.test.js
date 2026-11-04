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
