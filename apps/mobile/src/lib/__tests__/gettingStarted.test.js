/* global describe, test, expect, __dirname */
// Getting Started is one page; signing out of a patient account lands on Login, not on Getting Started.
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

describe('Getting Started: one page', () => {
  const welcome = read('app/welcome.js');
  test('the first page ("All your care in one place", with Skip, dots and Next) is gone, and so is the pager', () => {
    ['FlatList', 'PAGES', 'onboard_skip', 'onboard_next', 'onboard_2_title', 'ONBOARDING_CARE', 'scrollToIndex'].forEach((s) => expect(welcome).not.toContain(s));
    expect(read('data/images.js')).not.toContain('onboarding-care');
    ['onboarding-care.png', 'onboarding-care@2x.png', 'onboarding-care@3x.png'].forEach((f) => expect(fs.existsSync(path.join(__dirname, '../../../assets/images', f))).toBe(false));
  });
  test('what is left is the intro page, whose Get Started button opens Login', () => {
    expect(welcome).toContain('<GettingStartedIntro width={pageW} height={pageH} onNext={finish} />');
    expect(welcome).toContain("const finish = () => router.push('/login');");
  });
  test('a new person with no saved session still lands on it from the splash', () => {
    expect(read('app/index.js')).toContain("navReplace(token ? '/home' : '/welcome');");
  });
});

describe('sign out', () => {
  test('a patient goes straight to Login (a corporate account to the corporate login), not to Getting Started', () => {
    const profile = read('app/profile.js');
    expect(profile).toContain("navReplace(isCorporate ? '/corporate-login' : '/login'); await clearTokens();");
    expect(profile).not.toMatch(/signOut = async \(\) => \{ navReplace\([^)]*welcome/);
  });
});
