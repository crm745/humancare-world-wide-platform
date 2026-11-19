/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');

const login = fs.readFileSync(path.join(__dirname, '../../app/login.js'), 'utf8');

describe('the Vendor / Corporate Partner card on Login is switched off for now', () => {
  const start = login.indexOf("{/* Partner login is switched off for now");
  const card = login.slice(start, login.indexOf('</Body>'));
  test('it is still shown, dimmed, and announced as disabled', () => {
    expect(start).toBeGreaterThan(0);
    expect(card).toContain("t('login_partner_q')");
    expect(card).toContain("t('login_partner_cta')");
    expect(card).toContain('opacity-40');
    expect(card).toContain('accessibilityState={{ disabled: true }}');
  });
  test('it is not a button that can be pressed: no press handler and no way to the corporate login from it', () => {
    expect(card).not.toMatch(/Pressable|onPress|router\.push/);
    expect(login).not.toContain("router.push('/corporate-login')");
  });
});
