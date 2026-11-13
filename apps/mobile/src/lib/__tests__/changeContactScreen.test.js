/* global describe, test, expect, __dirname */
// Change mobile / email: the new value, then a code sent to it. No password, no old-contact code, for every account.
const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const NL = String.fromCharCode(10);
const code = (file) => read(file).split(NL).filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('import ')).join(NL);
const screen = read('../../app/change-contact.js');
const screenCode = code('../../app/change-contact.js');
const i18n = JSON.parse(read('../../data/i18n.json'));
const { isValidEmail, isValidMobileNumber } = require('../validators');

describe('no password anywhere in the screen', () => {
  test('there is no password field, state, validation, hint or error handling', () => {
    expect(screenCode).not.toMatch(new RegExp('password|PasswordField|invalid_password|account_locked|password_required', 'i'));
    expect(screen).not.toContain('PasswordField');
  });
  test('the request body is only the kind and the new value (mobile also sends its calling code)', () => {
    expect(screen).toContain("? { kind, mobile: phone.trim(), countryCode: cc }");
    expect(screen).toContain(': { kind, email: email.trim() };');
    expect(screen).toContain("apiPost('/auth/me/contact', body)");
    expect(screen.split("apiPost(").length - 1).toBe(1);
  });
  test('it goes on to the code screen for the NEW value', () => {
    expect(screen).toContain("setAuthStep('change-contact-otp', codeStepFrom(data, { kind }))");
    expect(screen).toContain("router.push('/change-contact-otp')");
  });
});

describe('the new value is validated before anything is sent', () => {
  test('the button is enabled only for a valid new mobile or email', () => {
    expect(screen).toContain('const ready = isMobile ? isValidMobileNumber(phone, cc) : isValidEmail(email);');
    expect(screen).toContain('disabled={!ready}');
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidMobileNumber('9876543210', '+91')).toBe(true);
    expect(isValidMobileNumber('123', '+91')).toBe(false);
  });
  test('a second tap while the request is running sends nothing, and the button shows loading', () => {
    expect(screen).toContain('if (!ready || busy) return;');
    expect(screen).toContain('loading={busy}');
    expect(screen).toContain('setBusy(false)');
  });
});

describe('adding a mobile to an account that has none', () => {
  test('the title and the hint say "Add", not "Change", when there is no current number', () => {
    expect(screen).toContain("t(isMobile ? (current ? 'change_mobile_title' : 'change_mobile_add_title') : 'change_email_title')");
    expect(screen).toContain("t(isMobile ? (current ? 'change_mobile_hint' : 'change_mobile_add_hint') : 'change_email_hint')");
  });
  test('the add texts exist in all six languages and are translated', () => {
    expect(i18n.EN.change_mobile_add_title).toBe('Add Mobile Number');
    for (const lang of Object.keys(i18n)) {
      expect(i18n[lang].change_mobile_add_title).toBeTruthy();
      expect(i18n[lang].change_mobile_add_hint).toBeTruthy();
      if (lang !== 'EN') {
        expect(i18n[lang].change_mobile_add_title).not.toBe(i18n.EN.change_mobile_add_title);
        expect(i18n[lang].change_mobile_add_hint).not.toBe(i18n.EN.change_mobile_add_hint);
      }
    }
  });
  test('the add hint does not talk about a "current number" that does not exist', () => {
    for (const lang of Object.keys(i18n)) expect(i18n[lang].change_mobile_add_hint).not.toMatch(/current|stays the same/i);
  });
});

describe('the "Current:" line', () => {
  test('an account with no mobile yet shows no "Current:" line (not "Current: +91")', () => {
    expect(screen).toContain("const current = isMobile ? (profile.phone ? `${profile.cc} ${profile.phone}` : '') : profile.email;");
    expect(screen).toContain('{current ? (');
    expect(screen).toContain("{t('change_contact_current')} <Text");
    expect(screen.indexOf('{current ? (')).toBeLessThan(screen.indexOf("t('change_contact_current')"));
  });
  test('the line is built only from a real number, so a bare calling code can never be shown', () => {
    expect(screen).not.toMatch(/`\$\{profile\.cc\} \$\{profile\.phone\}`\s*:\s*profile\.email/);
  });
});

describe('errors and states', () => {
  test('a refusal about the value (in use, wrong format, too soon) shows under the form; a server failure is a toast', () => {
    expect(screen).toContain('if (err.status && err.status < 500) setFormError(err.message);');
    expect(screen).toContain('else toast(err.message);');
  });
  test('the primary action says a code goes to the new number or email', () => {
    expect(screen).toContain("t(isMobile ? 'change_send_mobile_btn' : 'change_send_email_btn')");
    expect(i18n.EN.change_send_mobile_btn).toBe('Send OTP to New Number');
    expect(i18n.EN.change_send_email_btn).toBe('Send OTP to New Email');
  });
  test('the hint says nothing changes until the code is entered', () => {
    expect(screen).toContain("(current ? 'change_mobile_hint' : 'change_mobile_add_hint') : 'change_email_hint'");
    expect(i18n.EN.change_mobile_hint).toMatch(/stays the same until you enter the code/);
    expect(i18n.EN.change_email_hint).toMatch(/stays the same until you enter the code/);
  });
});

describe('Personal Details and the legacy Edit profile open the same flow for every account', () => {
  test('personal-details: no hasPassword gate', () => {
    const personal = read('../../app/personal-details.js');
    expect(personal).toContain("router.push({ pathname: '/change-contact', params: { kind } })");
    expect(personal).not.toContain('hasPassword');
    expect(personal).not.toContain('change_needs_password');
  });
  test('edit-profile: Change shows for every account and there is no "set a password first" note', () => {
    const edit = read('../../app/edit-profile.js');
    expect(edit).not.toContain('hasPassword');
    expect(edit).not.toContain('change_needs_password');
    expect(edit).not.toContain('cta_set_password');
    expect(edit).toContain("router.push({ pathname: '/change-contact', params: { kind } })");
  });
  test('after the code is verified the person lands on Personal details, not Profile', () => {
    const otp = read('../../app/change-contact-otp.js');
    expect(otp).toContain("next: '/personal-details'");
    expect(otp).not.toContain("next: '/profile'");
    expect(otp).toContain('<Redirect href="/personal-details" />');
  });
  test('the code screen\'s success message is translated', () => {
    const otp = read('../../app/change-contact-otp.js');
    expect(otp).toContain("toast(t(kind === 'mobile' ? 'change_mobile_updated' : 'change_email_updated'))");
    expect(otp).not.toMatch(/toast\('/);
  });
});

describe('no string of this screen is hard-coded English', () => {
  test('no placeholder or message literal except the example address', () => {
    const literals = screenCode.match(new RegExp("(placeholder|toast[(]|error=)[^t{]*['\"][A-Z][a-z]+ [A-Za-z ]+['\"]", 'g')) || [];
    expect(literals).toEqual([]);
    expect(screen).not.toContain('Enter a valid');
    expect(screen).not.toContain("toast('OTP sent')");
  });
});

describe('translations for the flow, in all six languages', () => {
  const KEYS = ['change_mobile_title', 'change_email_title', 'change_contact_current', 'field_new_mobile', 'field_new_email', 'change_mobile_hint', 'change_email_hint',
    'cta_change', 'register_email_otp_title', 'change_err_mobile', 'change_err_email', 'change_otp_sent', 'change_mobile_updated', 'change_email_updated', 'change_send_mobile_btn', 'change_send_email_btn'];
  test('every key exists in EN, HI, MR, GU, TE and AR', () => {
    expect(Object.keys(i18n)).toEqual(['EN', 'HI', 'MR', 'GU', 'TE', 'AR']);
    for (const lang of Object.keys(i18n)) for (const key of KEYS) expect(i18n[lang][key]).toBeTruthy();
  });
  test('the other five languages are translated, not copies of English', () => {
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) for (const key of KEYS) expect(i18n[lang][key]).not.toBe(i18n.EN[key]);
  });
  test('the password-only texts are gone from every language', () => {
    for (const lang of Object.keys(i18n)) {
      for (const key of ['field_current_password', 'change_needs_password', 'cta_set_password']) expect(i18n[lang][key]).toBeUndefined();
    }
    for (const lang of Object.keys(i18n)) expect(i18n[lang].change_mobile_hint).not.toMatch(/password/i);
  });
  test('no key of the flow carries a placeholder that is not in English', () => {
    for (const lang of Object.keys(i18n)) for (const key of KEYS) expect(i18n[lang][key]).not.toContain('{{');
  });
});
