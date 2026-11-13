/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const screen = read('../../app/profile.js');
const i18n = JSON.parse(read('../../data/i18n.json'));
const KEYS = ['prof_title', 'prof_account', 'prof_preferences', 'prof_support', 'prof_personal', 'prof_documents', 'prof_payment', 'prof_language', 'prof_notifications', 'prof_privacy', 'prof_help', 'prof_terms', 'prof_logout', 'prof_footer', 'prof_soon'];

describe('Profile screen', () => {
  test('every label exists in every language', () => {
    for (const lang of Object.keys(i18n)) for (const k of KEYS) expect(i18n[lang][k]).toBeTruthy();
  });
  test('the footer carries the version placeholder', () => {
    expect(i18n.EN.prof_footer).toContain('{v}');
  });
  test('the old stats call is gone from this screen', () => {
    expect(screen).not.toMatch(/apiGet|\/requests\/me|\/corporate\/cases/);
  });
  test('rows open the screens that exist', () => {
    for (const route of ['/my-documents', '/notifications', '/privacy', '/help-support', '/terms']) expect(screen).toContain(`'${route}'`);
  });
  test('Personal details opens its screen for a patient and says "Coming soon" for a corporate; Payment (no screen yet) says "Coming soon"', () => {
    expect(screen).toContain("t('prof_personal'), onPress: isCorporate ? soon : () => router.push('/personal-details')");
    expect(screen).toContain("t('prof_payment'), onPress: soon");
  });
  test('Emergency contacts is not on the screen', () => {
    expect(screen).not.toMatch(/emergency|Siren/i);
  });
  test('log out clears the session as before', () => {
    expect(screen).toContain('clearTokens()');
  });
  test('the version comes from the app config', () => {
    expect(screen).toContain('Constants.expoConfig?.version');
  });
});
