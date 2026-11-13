/* global describe, test, expect */
const { TRACKING_FAMILY, familyForServiceKey, resolveTrackingFamily, isPrivateCharterTracking } = require('../tracking/serviceFamily');

describe('familyForServiceKey', () => {
  test('the Private Charter key is the Private Charter family', () => {
    expect(familyForServiceKey('privatecharter')).toBe('privatecharter');
    expect(TRACKING_FAMILY.PRIVATE_CHARTER).toBe('privatecharter');
  });

  test('the legacy "air" key is generic: it is not classified as Private Charter', () => {
    expect(familyForServiceKey('air')).toBe('generic');
  });

  test.each([
    'commercialair', 'commercialair_stretcher', 'commercialair_wheelchair', 'ground', 'hospital', 'homecare',
    'tele', 'corporate', 'mortal', 'mortal_domestic', 'mortal_international', 'escort',
  ])('%s is generic', (key) => {
    expect(familyForServiceKey(key)).toBe('generic');
    expect(TRACKING_FAMILY.GENERIC).toBe('generic');
  });

  test.each([undefined, null, '', '   ', 0, 7, true, {}, [], 'somethingelse', 'PrivateCharter', 'PRIVATECHARTER', ' privatecharter', 'privatecharter_x', 'Air'])(
    'a missing or unknown key (%p) is generic',
    (key) => {
      expect(familyForServiceKey(key)).toBe('generic');
    },
  );
});

describe('resolveTrackingFamily', () => {
  test('reads the request serviceKey', () => {
    expect(resolveTrackingFamily({ serviceKey: 'privatecharter' })).toBe('privatecharter');
    expect(resolveTrackingFamily({ serviceKey: 'air' })).toBe('generic');
    expect(resolveTrackingFamily({ serviceKey: 'ground' })).toBe('generic');
  });

  test('a request with no serviceKey (older rows) is generic', () => {
    expect(resolveTrackingFamily({})).toBe('generic');
    expect(resolveTrackingFamily({ serviceKey: null })).toBe('generic');
    expect(resolveTrackingFamily(null)).toBe('generic');
    expect(resolveTrackingFamily(undefined)).toBe('generic');
  });

  test('never identifies Private Charter from the display title', () => {
    expect(resolveTrackingFamily({ serviceType: 'Private Charter Air Ambulance Service' })).toBe('generic');
    expect(resolveTrackingFamily({ serviceKey: null, serviceType: 'Private Charter Air Ambulance Service' })).toBe('generic');
    expect(resolveTrackingFamily({ serviceKey: 'ground', serviceType: 'Private Charter Air Ambulance Service' })).toBe('generic');
    expect(resolveTrackingFamily({ serviceKey: 'privatecharter', serviceType: 'Ground Ambulance' })).toBe('privatecharter');
  });
});

describe('isPrivateCharterTracking', () => {
  test('is true only for the Private Charter family', () => {
    expect(isPrivateCharterTracking({ serviceKey: 'privatecharter' })).toBe(true);
    expect(isPrivateCharterTracking({ serviceKey: 'air' })).toBe(false);
    expect(isPrivateCharterTracking({ serviceKey: 'commercialair_stretcher' })).toBe(false);
    expect(isPrivateCharterTracking(null)).toBe(false);
  });

  test('"air" stays generic even when its title is the Private Charter name or it has review fields', () => {
    expect(isPrivateCharterTracking({ serviceKey: 'air', serviceType: 'Private Charter Air Ambulance Service' })).toBe(false);
    expect(isPrivateCharterTracking({ serviceKey: 'air', serviceType: 'Air Ambulance', reviewStatus: 'in_review' })).toBe(false);
  });

  test('the form alias is untouched: normalizeServiceKey still maps air to privatecharter for the request form', () => {
    const { normalizeServiceKey, isPrivateCharter } = require('../privateCharter');
    expect(normalizeServiceKey('air')).toBe('privatecharter');
    expect(isPrivateCharter('air')).toBe(true);
  });
});
