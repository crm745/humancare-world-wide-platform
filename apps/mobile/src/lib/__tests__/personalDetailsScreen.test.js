/* global describe, test, expect, __dirname */
// The Personal details screen: exactly four sections, built on the existing API client and endpoints, showing only
// what exists, never editing mobile, email or a verification flag, and wired from Profile.
const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const screen = read('../../app/personal-details.js');
// The code only: comments may name what the screen does not show.
const NL = String.fromCharCode(10);
const code = screen.split(NL).filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('import ') && !l.includes('{/*')).join(NL);
const i18n = JSON.parse(read('../../data/i18n.json'));
const { isPublicRoute } = require('../authGuard');

const KEYS = ['pd_account_label', 'pd_section_personal', 'pd_section_contact', 'pd_section_verify', 'pd_section_account', 'pd_edit', 'pd_cancel', 'pd_verified', 'pd_pending',
  'pd_email_verification', 'pd_account_verification', 'pd_email_pending_note', 'pd_account_type', 'pd_patient', 'pd_member_since',
  'pd_nothing_yet', 'pd_load_failed', 'pd_try_again', 'pd_saved', 'pd_no_changes', 'pd_err_first', 'pd_err_last', 'pd_err_full', 'pd_select_nationality'];

describe('the screen uses what already exists', () => {
  test('the existing API client and the two existing endpoints, nothing else', () => {
    expect(screen).toContain("import { apiGet, apiPatch } from '../lib/api'");
    expect(screen.match(new RegExp('apiGet[(]', 'g'))).toHaveLength(1);
    expect(screen.match(new RegExp('apiPatch[(]', 'g'))).toHaveLength(1);
    expect(screen).toContain("apiGet('/auth/me')");
    expect(screen).toContain("apiPatch('/auth/me', patch)");
    expect(screen).not.toMatch(new RegExp('fetch[(]|axios|apiPost[(]|apiUpload'));
  });
  test('shared TopBar, Body, Card, Field, InfoRow and Button', () => {
    expect(screen).toContain("import { Body, Screen, TopBar } from '../components/layout'");
    expect(screen).toContain("import { Button, Card, Field, FieldLabel, InfoRow, Text } from '../components/ui'");
  });
  test('it is a protected screen (not in the public routes)', () => {
    expect(isPublicRoute('/personal-details')).toBe(false);
  });
  test('Profile opens it for a patient', () => {
    expect(read('../../app/profile.js')).toContain("router.push('/personal-details')");
  });
});

describe('exactly four sections', () => {
  const sections = screen.match(new RegExp('<SectionCard[^>]*>|<SectionCard$', 'gm')) || [];
  test('Personal Information, Contact Information, Verification Information and Account Information, in that order', () => {
    const order = ["t('pd_section_personal')", "t('pd_section_contact')", "t('pd_section_verify')", "t('pd_section_account')"];
    const at = order.map((o) => screen.indexOf(o, screen.indexOf('export default function PersonalDetails')));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(screen.split('<SectionCard').length - 1).toBe(4);
    expect(sections.length).toBeGreaterThan(0);
  });
  test('each section has an icon and a heading', () => {
    expect(screen).toContain("import { ChevronDown, IdCard, Phone, ShieldCheck, User } from 'lucide-react-native'");
    for (const icon of ['Icon={User}', 'Icon={Phone}', 'Icon={ShieldCheck}', 'Icon={IdCard}']) expect(screen).toContain(icon);
    expect(screen).toContain('accessibilityRole="header"');
  });
  test('the header is the initials avatar, the name and the "Patient account" label', () => {
    expect(screen).toContain('initialsOf(view.name)');
    expect(screen).toContain("t('pd_account_label')");
  });
  test('English labels of the four sections', () => {
    expect([i18n.EN.pd_section_personal, i18n.EN.pd_section_contact, i18n.EN.pd_section_verify, i18n.EN.pd_section_account])
      .toEqual(['Personal Information', 'Contact Information', 'Verification Information', 'Account Information']);
  });
});

describe('A. Personal Information', () => {
  test('edit, save and cancel; the form can only send what buildPatch allows', () => {
    expect(screen).toContain('const patch = buildPatch(view, form);');
    expect(screen).toContain('const found = validateForm(view, form);');
    expect(screen).toContain("t('pd_cancel')");
    expect(screen).toContain("t('btn_save_changes')");
  });
  test('a second tap while saving does nothing, and the button shows loading', () => {
    expect(screen).toContain('if (saving) return;');
    expect(screen).toContain('loading={saving}');
  });
  test('a failed save keeps the typed values and the saved account, and says why', () => {
    const save = screen.slice(screen.indexOf('const save = async'), screen.indexOf('// Email and mobile change only'));
    expect(save.indexOf('setUser(updated)')).toBeGreaterThan(save.indexOf('await apiPatch'));
    expect(save).toContain('setSaveError(err.message)');
    expect(save).toContain('setSaving(false)');
    expect(save.slice(save.indexOf('catch (err)'), save.indexOf('finally'))).not.toContain('setUser');
  });
  test('after a save the app\'s own profile (initials, name) follows the answer', () => {
    expect(screen).toContain('setProfile(profileFromUser(updated))');
  });
});

describe('B. Contact Information', () => {
  test('email and mobile each have a Change action, and neither is an edit box', () => {
    expect(screen).toContain("onChange={() => goChange('email')}");
    expect(screen).toContain("onChange={() => goChange('mobile')}");
    expect(screen).toContain("t(value ? 'cta_change' : 'cta_add')");
    expect(screen).not.toMatch(new RegExp('<Field[^>]*(email|mobile)', 'i'));
  });
  test('a contact with no value yet says "Add" instead of "Change", on the button and in its accessibility label', () => {
    expect(screen).toContain("accessibilityLabel={`${t(value ? 'cta_change' : 'cta_add')} ${label}`}");
    expect(screen.split("t(value ? 'cta_change' : 'cta_add')").length - 1).toBe(2); // the label and the visible text
    expect(i18n.EN.cta_add).toBe('Add');
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) {
      expect(i18n[lang].cta_add).toBeTruthy();
      expect(i18n[lang].cta_add).not.toBe(i18n.EN.cta_add);
      expect(i18n[lang].cta_add).not.toBe(i18n[lang].cta_change);
    }
  });
  test('Change opens the code flow for every account: nothing about a password gets in the way', () => {
    expect(screen).toContain("const goChange = (kind) => router.push({ pathname: '/change-contact', params: { kind } });");
    expect(code).not.toMatch(new RegExp('hasPassword|change_needs_password|cta_set_password|password', 'i'));
  });
  test('the mobile number and its country are ONE value; there is no separate country or calling-code row', () => {
    expect(screen).toContain('value={view.mobile.text}');
    expect(code).not.toMatch(new RegExp('mobile_country|phoneCountry|countryCode|country_code|calling', 'i'));
    expect(screen.split("t('field_mobile_number')").length - 1).toBe(1);
  });
});

describe('C. Verification Information', () => {
  test('email and account verification as read-only chips, with no input', () => {
    expect(screen).toContain("t('pd_email_verification')");
    expect(screen).toContain("t('pd_account_verification')");
    expect(screen).toContain('<StatusChip ok={view.emailVerified} t={t} />');
    expect(screen).toContain('<StatusChip ok={view.accountVerified} t={t} />');
    expect(screen).not.toMatch(new RegExp('emailVerifiedAt|isVerified')); // only the pure helper reads them
  });
  test('the explanation shows when the email is pending', () => {
    expect(screen).toContain("{!view.emailVerified ? <Text");
    expect(screen).toContain("t('pd_email_pending_note')");
    expect(i18n.EN.pd_email_pending_note).toBe('Your email will be verified when you complete the email OTP verification process.');
  });
  test('no separate mobile verification badge', () => {
    expect(code).not.toMatch(new RegExp('mobile.*verif|verif.*mobile', 'i'));
  });
});

describe('D. Account Information', () => {
  test('account type Patient and the member-since date, with no invented account status', () => {
    expect(screen).toContain("t('pd_account_type')");
    expect(screen).toContain("t('pd_patient')");
    expect(screen).toContain("t('pd_member_since')");
    expect(screen).toContain('view.memberSince');
    expect(code).not.toMatch(new RegExp('account_status|accountStatus|pd_status', 'i'));
  });
  test('English values', () => {
    expect([i18n.EN.pd_account_type, i18n.EN.pd_patient, i18n.EN.pd_member_since]).toEqual(['Account Type', 'Patient', 'Member Since']);
  });
});

describe('what is NOT on the screen', () => {
  test('no Sign-in Methods, password state, Google or Apple', () => {
    expect(code).not.toMatch(new RegExp('sign.?in method|signin_method|googleId|appleId|google|apple|hasGoogle|hasApple|password set|not set', 'i'));
    expect(code).not.toMatch(new RegExp('pd_password|pd_signin|t[(].pd_.*password', 'i'));
  });
  test('no date of birth, address, state, city, postal code, photo, medical history or terms date', () => {
    expect(screen).not.toMatch(new RegExp('dateOfBirth|date_of_birth|postalCode|postal_code|field_address|field_city|field_state|field_country|streetAddress|profilePhoto|medicalHistory|termsAccepted|acceptedAt', 'i'));
  });
  test('the translation files have no Sign-in Methods text either', () => {
    for (const lang of Object.keys(i18n)) for (const key of Object.keys(i18n[lang])) {
      if (key.startsWith('pd_')) expect(key).not.toMatch(new RegExp('signin|sign_in|google|apple|password', 'i'));
    }
  });
});

describe('screen states', () => {
  test('a corporate account sees "Coming soon", never a patient\'s form', () => {
    expect(screen).toContain('if (isCorporate)');
  });
  test('loading, failure with a retry, and an empty state', () => {
    expect(screen).toContain('<LoadingState />');
    expect(screen).toContain("t('pd_try_again')");
    expect(screen).toContain("t('pd_nothing_yet')");
  });
  test('no user-facing string is hard-coded in the screen', () => {
    const jsxText = screen.match(new RegExp('>[A-Z][A-Za-z ]{3,}<', 'g')) || [];
    expect(jsxText).toEqual([]);
  });
});

describe('translations', () => {
  test('every label exists in all six languages, with English as the default', () => {
    expect(Object.keys(i18n)).toHaveLength(6);
    for (const lang of Object.keys(i18n)) for (const key of KEYS) expect(i18n[lang][key]).toBeTruthy();
    expect(i18n.EN.pd_account_label).toBe('Patient account');
  });
  test('every language except English is actually translated for the new labels', () => {
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) {
      for (const key of ['pd_section_verify', 'pd_section_account', 'pd_email_verification', 'pd_account_verification', 'pd_email_pending_note', 'pd_account_type', 'pd_patient', 'pd_member_since']) {
        expect(i18n[lang][key]).not.toBe(i18n.EN[key]);
      }
    }
  });
  test('the obsolete keys are gone', () => {
    for (const lang of Object.keys(i18n)) {
      expect(i18n[lang].pd_account).toBeUndefined();
      expect(i18n[lang].pd_change_hint).toBeUndefined();
    }
  });
});
