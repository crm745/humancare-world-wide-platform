/* global describe, test, expect, __dirname */
// Patient-visible text uses commas, colons and full stops, not em dashes or en dash separators.
// Allowed: en dashes inside number ranges (72–96, 4–6), and the em dash as the "no value" placeholder.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const EM = '\u2014';

const strings = (obj, out = []) => {
  Object.entries(obj).forEach(([k, v]) => (typeof v === 'string' ? out.push([k, v]) : v && typeof v === 'object' && strings(v, out)));
  return out;
};

describe('punctuation in patient-visible text', () => {
  const i18n = JSON.parse(read('data', 'i18n.json'));

  test.each(Object.keys(i18n))('%s dictionary has no em dash', (lang) => {
    const bad = strings(i18n[lang]).filter(([, v]) => v.includes(EM)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  test.each(Object.keys(i18n))('%s dictionary uses an en dash only between digits', (lang) => {
    const bad = strings(i18n[lang]).filter(([, v]) => /(?<!\d)–|–(?!\d)/.test(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  test('service descriptions and About text have no em dash', () => {
    const services = strings(JSON.parse(read('data', 'services.json')));
    expect(services.filter(([, v]) => v.includes(EM))).toEqual([]);
    expect(read('data', 'aboutContent.js')).not.toContain(EM);
  });

  test('the privacy sentence reads as approved', () => {
    expect(i18n.EN.privacy_s1_b).toBe('We collect information you provide directly, including your name, contact number, email, and, where relevant to a request, patient medical details, care level, and uploaded medical reports.');
  });
});
