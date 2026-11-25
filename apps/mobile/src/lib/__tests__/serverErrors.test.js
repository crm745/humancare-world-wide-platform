/* global describe, test, expect */
// The words of a server refusal, in the person's language (M1): the backend sends a stable code (and field / params / fieldCodes) with every refusal of the request and document-upload API, and the app
// turns it into the dictionary text of EN, HI, MR, GU, TE or AR, with the server's English message as the fallback. Pure (no React, no native modules).
import I18N from '../../data/i18n.json';
import SERVER_ERRORS from '../../data/serverErrorKeys.json';
import { translate } from '../translate';
import { errorText } from '../errorText';
import { fieldErrorsFromError } from '../privateCharter';
import { localizedServerError, localizedFieldError, FIELD_LABEL_KEYS, SERVER_ERROR_CODES } from '../serverErrors';

const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const tFor = (lang) => (key, values) => translate(I18N, lang, key, values);
const refusal = (extra = {}, message = 'The server said no (in English)') => Object.assign(new Error(message), { status: 400, ...extra });

describe('a refusal with a known code is shown in each of the six languages', () => {
  const SAMPLES = [
    ['phone_invalid', { field: 'patientContact' }],
    ['date_past', { field: 'preferredDate' }],
    ['required', { field: 'patientName' }],
    ['text_too_long', { field: 'origin', params: { max: 191 } }],
    ['number_range', { field: 'patientAge', params: { min: 0, max: 129 } }],
    ['too_many_documents', { params: { max: 30 } }],
    ['request_closed', {}],
    ['file_type_mismatch', {}],
    ['file_empty', {}],
    ['file_too_large', {}],
    ['file_infected', {}],
    ['scan_unavailable', {}],
    ['rate_limited', {}],
    ['app_update_required', {}],
    ['oxygen_rate_range', { params: { max: 15 } }],
  ];
  test.each(LANGS)('%s: every sample gives text in that language (never the English server message, never a raw key)', (lang) => {
    const t = tFor(lang);
    for (const [code, extra] of SAMPLES) {
      const text = localizedServerError(refusal({ code, ...extra }), t);
      expect({ code, lang, shown: typeof text }).toEqual({ code, lang, shown: 'string' });
      expect(text).not.toContain('The server said no');
      expect(text).not.toMatch(/^(srv_|req_|err_|up_)/);
      expect(text).not.toMatch(/\{[a-z]+\}/); // every placeholder was filled
    }
  });
  test('the translated text is really in the other script (Hindi / Marathi Devanagari, Gujarati, Telugu, Arabic)', () => {
    const SCRIPT = { HI: /[ऀ-ॿ]/, MR: /[ऀ-ॿ]/, GU: /[઀-૿]/, TE: /[ఀ-౿]/, AR: /[؀-ۿ]/ };
    for (const [lang, script] of Object.entries(SCRIPT)) {
      for (const code of ['date_past', 'request_closed', 'file_infected', 'rate_limited', 'validation_failed']) {
        expect({ lang, code, ok: script.test(localizedServerError(refusal({ code }), tFor(lang))) }).toEqual({ lang, code, ok: true });
      }
    }
  });
  test('numbers are filled in, also through the renamed placeholder of an existing text (req_file_max says {n})', () => {
    expect(localizedServerError(refusal({ code: 'too_many_documents', params: { max: 30 } }), tFor('EN'))).toBe('You can attach up to 30 files.');
    expect(localizedServerError(refusal({ code: 'too_many_documents', params: { max: 10 } }), tFor('HI'))).toContain('10');
    expect(localizedServerError(refusal({ code: 'number_range', field: 'patientAge', params: { min: 1, max: 120 } }), tFor('EN'))).toBe('Patient age: Enter a whole number from 1 to 120.');
    expect(localizedServerError(refusal({ code: 'text_too_long', params: { max: 191 } }), tFor('AR'))).toContain('191');
  });
  test('a field label is put in front when the field is known, in the same language', () => {
    expect(localizedServerError(refusal({ code: 'phone_invalid', field: 'patientContact' }), tFor('EN'))).toBe('Contact number: Enter a valid number for the selected country.');
    expect(localizedServerError(refusal({ code: 'date_past', field: 'preferredDate' }), tFor('HI'))).toBe(`${I18N.HI.field_preferred_date}: ${I18N.HI.srv_date_past}`);
    expect(localizedServerError(refusal({ code: 'required', field: 'patientName' }), tFor('AR'))).toBe(`${I18N.AR.field_patient_name}: ${I18N.AR.req_required}`);
    // an unknown field name gives the reason alone, never the raw name
    expect(localizedServerError(refusal({ code: 'required', field: 'someFutureField' }), tFor('EN'))).toBe('This field is required.');
    expect(localizedServerError(refusal({ code: 'required' }), tFor('EN'))).toBe('This field is required.');
  });
  test('existing translations are reused where they exist', () => {
    const EN = tFor('EN');
    expect(localizedServerError(refusal({ code: 'file_type_unsupported' }), EN)).toBe(I18N.EN.req_file_type);
    expect(localizedServerError(refusal({ code: 'file_too_large' }), EN)).toBe(I18N.EN.req_file_big);
    expect(localizedServerError(refusal({ code: 'file_upload_invalid' }), EN)).toBe(I18N.EN.up_failed_generic);
    expect(localizedServerError(refusal({ code: 'city_invalid' }), EN)).toBe(I18N.EN.err_select_city);
    expect(localizedServerError(refusal({ code: 'date_invalid' }), EN)).toBe(I18N.EN.err_valid_date);
  });
});

describe('fallback behaviour', () => {
  const t = tFor('HI');
  test('no code, an unknown code or a non-text code: null (the caller shows the server\'s English message)', () => {
    for (const code of [undefined, null, '', 'brand_new_code', 5, {}, '__proto__', 'constructor', 'toString']) expect(localizedServerError(refusal({ code }), t)).toBeNull();
    expect(localizedServerError(null, t)).toBeNull();
    expect(localizedServerError(undefined, t)).toBeNull();
  });
  test('a number the sentence needs that was not sent (or is not a number) gives null, never a half-filled sentence or injected text', () => {
    expect(localizedServerError(refusal({ code: 'too_many_documents' }), t)).toBeNull();
    expect(localizedServerError(refusal({ code: 'text_too_long' }), t)).toBeNull();
    expect(localizedServerError(refusal({ code: 'number_range', params: { min: 1 } }), t)).toBeNull();
    expect(localizedServerError(refusal({ code: 'too_many_documents', params: { max: '<script>alert(1)</script>' } }), t)).toBeNull();
    expect(localizedServerError(refusal({ code: 'too_many_documents', params: { max: Infinity } }), t)).toBeNull();
    expect(localizedServerError(refusal({ code: 'too_many_documents', params: { max: NaN } }), t)).toBeNull();
  });
  test('a language that lacks a key falls back to English text for it (the app\'s usual lookup), not to a raw key', () => {
    const dictionary = { EN: { srv_date_past: 'EN past', field_preferred_date: 'EN label' }, HI: { field_preferred_date: 'HI label' } };
    const tPartial = (key, values) => translate(dictionary, 'HI', key, values);
    expect(localizedServerError(refusal({ code: 'date_past', field: 'preferredDate' }), tPartial)).toBe('HI label: EN past');
  });
  test('a key missing from every language gives null (the server\'s message is shown)', () => {
    const tNone = (key) => key; // the app's t() returns the key itself when it has no text
    expect(localizedServerError(refusal({ code: 'date_past' }), tNone)).toBeNull();
    expect(localizedServerError(refusal({ code: 'date_past' }), undefined)).toBeNull();
  });
  test('errorText: a coded refusal is translated, an uncoded or unknown one keeps the server\'s message', () => {
    expect(errorText(refusal({ code: 'request_closed' }), tFor('GU'))).toBe(I18N.GU.srv_request_closed);
    expect(errorText(refusal({}, 'Some English from the server'), tFor('GU'))).toBe('Some English from the server');
    expect(errorText(refusal({ code: 'brand_new_code' }, 'Some English from the server'), tFor('GU'))).toBe('Some English from the server');
  });
  test('errorText: the app\'s own errors and session codes keep their existing handling and come first', () => {
    const own = Object.assign(new Error('Could not reach the server. Please try again.'), { code: 'network' });
    expect(errorText(own, tFor('TE'))).toBe(I18N.TE.err_network_short);
    const login = Object.assign(new Error('Invalid credentials'), { status: 401, code: 'invalid_credentials' });
    expect(errorText(login, tFor('TE'))).toBe('Invalid credentials'); // not a request/upload code: unchanged
  });
});

describe('a refused field (fieldCodes) is shown under its field in the person\'s language', () => {
  const err = (data) => Object.assign(new Error('Please correct the highlighted fields.'), { status: 400, data });
  const data = {
    fields: { patientName: 'Patient name is required.', preferredDate: 'Preferred date cannot be in the past.', age: 'Age must be a whole number from 1 to 120.', odd: 'Some unknown text' },
    fieldCodes: { patientName: { code: 'required' }, preferredDate: { code: 'date_past' }, age: { code: 'number_range', params: { min: 1, max: 120 } }, odd: { code: 'validation_failed' } },
  };
  test('with a translator each message is the dictionary text (no label in front: it sits under its own field)', () => {
    const out = fieldErrorsFromError(err(data), tFor('MR'));
    expect(out.patientName).toBe(I18N.MR.req_required);
    expect(out.preferredDate).toBe(I18N.MR.srv_date_past);
    expect(out.age).toBe('1 ते 120 दरम्यानची पूर्ण संख्या टाका.');
    expect(out.odd).toBe(I18N.MR.srv_validation_failed);
  });
  test('without a translator, or without codes, it is the server\'s text exactly as before', () => {
    const plain = fieldErrorsFromError(err(data));
    expect(plain).toEqual(data.fields);
    expect(fieldErrorsFromError(err({ fields: data.fields }), tFor('MR'))).toEqual(data.fields);
  });
  test('a field with an unknown code keeps the server\'s message', () => {
    const out = fieldErrorsFromError(err({ fields: { a: 'English a' }, fieldCodes: { a: { code: 'never_heard_of_it' } } }), tFor('TE'));
    expect(out.a).toBe('English a');
  });
  test('localizedFieldError handles bad input', () => {
    for (const item of [undefined, null, {}, { code: 5 }, { code: 'nope' }]) expect(localizedFieldError(item, 'x', tFor('EN'))).toBeNull();
  });
});

describe('the code list the app translates', () => {
  test('every code maps to a key that exists in all six languages, with the same placeholders in each', () => {
    const placeholders = (text) => (text.match(/\{[a-z]+\}/g) || []).sort().join(',');
    for (const [code, entry] of Object.entries(SERVER_ERRORS)) {
      for (const lang of LANGS) {
        expect({ code, lang, text: typeof I18N[lang][entry.key] }).toEqual({ code, lang, text: 'string' });
        expect({ code, lang, p: placeholders(I18N[lang][entry.key]) }).toEqual({ code, lang, p: placeholders(I18N.EN[entry.key]) });
      }
    }
    expect(SERVER_ERROR_CODES).toEqual(Object.keys(SERVER_ERRORS));
  });
  test('every field label key exists in all six languages', () => {
    for (const key of new Set(Object.values(FIELD_LABEL_KEYS))) for (const lang of LANGS) expect({ key, lang, text: typeof I18N[lang][key] }).toEqual({ key, lang, text: 'string' });
  });
  test('the English dictionary text agrees with what the server says in English for the codes the server writes itself', () => {
    const EN = tFor('EN');
    expect(localizedServerError(refusal({ code: 'file_infected' }), EN)).toBe('This file was blocked because it may contain a virus. It was not saved.');
    expect(localizedServerError(refusal({ code: 'scan_unavailable' }), EN)).toBe('We could not scan this file for viruses right now, so it was not saved. Please try again in a moment.');
    expect(localizedServerError(refusal({ code: 'app_update_required' }), EN)).toBe('This version of the app can no longer send this request. Please update the app and try again.');
    expect(localizedServerError(refusal({ code: 'request_approved' }), EN)).toBe('This request has been approved. Please contact HumanCare to add more documents.');
  });
});

describe('a refused file in the upload list (stored with its English message only)', () => {
  const { localizedUploadMessage } = require('../serverErrors');
  test('the upload refusals are shown in the language of the person', () => {
    expect(localizedUploadMessage('The file content does not match its type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.', tFor('HI'))).toBe(I18N.HI.srv_file_mismatch);
    expect(localizedUploadMessage('The uploaded file is empty.', tFor('AR'))).toBe(I18N.AR.srv_file_empty);
    expect(localizedUploadMessage('A request can hold at most 30 documents.', tFor('EN'))).toBe('You can attach up to 30 files.');
    expect(localizedUploadMessage('A Mortal Remains request can have at most 10 documents.', tFor('GU'))).toContain('10');
    expect(localizedUploadMessage('This request is cancelled, so documents can no longer be added. Please contact HumanCare if you need to share something.', tFor('TE'))).toBe(I18N.TE.srv_request_closed);
    expect(localizedUploadMessage('Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.', tFor('MR'))).toBe(I18N.MR.req_file_type);
    expect(localizedUploadMessage('File too large', tFor('HI'))).toBe(I18N.HI.req_file_big);
    expect(localizedUploadMessage('We could not scan this file for viruses right now, so it was not saved. Please try again in a moment.', tFor('TE'))).toBe(I18N.TE.srv_scan_unavailable);
  });
  test('anything else (including the app\'s own already-translated messages) is left as stored', () => {
    for (const message of ['Upload failed. Please try again.', 'Some other server text', '', null, undefined, 5, I18N.HI.up_failed_generic]) expect(localizedUploadMessage(message, tFor('HI'))).toBeNull();
  });
});
