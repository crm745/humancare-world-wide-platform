/* global describe, it, expect, __dirname */
const fs = require('fs');
const path = require('path');
const { isMissingLiveService } = require('../serviceLookup');
const SERVICES = require('../../data/services.json');

describe('service detail: the live-text lookup', () => {
  it('a 404 is normal (no editable text for this service) and is not reported', () => {
    expect(isMissingLiveService(Object.assign(new Error('Service not found'), { status: 404 }))).toBe(true);
  });

  it('every other failure is still reported', () => {
    expect(isMissingLiveService(Object.assign(new Error('Internal server error'), { status: 500 }))).toBe(false);
    expect(isMissingLiveService(Object.assign(new Error('Too many requests'), { status: 429 }))).toBe(false);
    expect(isMissingLiveService(new TypeError('Network request failed'))).toBe(false); // no status at all
    expect(isMissingLiveService(undefined)).toBe(false);
  });

  it('the screen uses it, so only a missing record is silent', () => {
    const screen = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'service', '[key].js'), 'utf8');
    expect(screen).toMatch(/if \(!isMissingLiveService\(err\)\) toast\(err\.message\)/);
  });

  it('none of the app\'s service keys is a backend slug, which is why every lookup 404s today', () => {
    const slugs = ['air_ambulance', 'ground_ambulance', 'hospitalization', 'medical_escort', 'mortal_remains', 'home_healthcare', 'teleconsultation', 'other'];
    expect(Object.keys(SERVICES).filter((key) => slugs.includes(key))).toEqual([]);
  });
});
