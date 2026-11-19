import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import I18N from '../data/i18n.json';
import { DEFAULT_LANGUAGE, isRtlLanguage, isSupportedLanguage, localeOf } from '../data/languages';
import { setDateLocale } from '../lib/dateFormat';
import { resolveInitialLanguage, saveLanguage } from '../lib/languagePreference';
import { translate } from '../lib/translate';
import { apiGet } from '../lib/api';
import { getAccessToken, onSessionChange } from '../lib/session';
import { createAuthStore } from '../lib/authState';
import { profileFromUser } from '../lib/profile';
import { clearCache } from '../lib/screenCache';
import { draftForService, needsCareLevel } from '../lib/requestForm';
import { clearErrorsForPatch } from '../lib/privateCharter';

const AppContext = createContext(null);

const INITIAL_PROFILE = { name: '', cc: '+91', phone: '', email: '' };

// `/auth/me` returns either `{ user }` (patient) or `{ corporateUser }` (corporate),
// shaped by the role baked into the JWT — same split login.js/corporate-otp.js already
// make when they set the profile right after a fresh login.
function profileFromMe(data) {
  if (data.corporateUser) {
    const c = data.corporateUser;
    return { session: 'corporate', profile: { name: c.corporate?.companyName || c.email, cc: '+91', phone: '', email: c.email } };
  }
  return { session: 'patient', profile: profileFromUser(data.user) };
}

export const INITIAL_DRAFT = {
  service: 'air',
  name: '',
  age: '',
  gender: '',
  location: '',
  sentRequest: null, // Private Charter: { id, referenceNumber, title } once the request is saved, so a retry never saves it twice
  uploaded: [], // Private Charter: the uri of each report file the server has accepted
  uploadErrors: {}, // Private Charter: { uri: message } for the files that failed on the last attempt
  originCity: null, // Private Charter: the verified city picked for Location, { geonameId, name, label, countryCode }
  destCity: null, // Private Charter: the same for Destination
  country: '', // the country's name, as it is sent to the backend
  countryIso: '', // its ISO code, which the phone code follows (see pickRequestCountry)
  cc: '+91', // the calling code sent with the contact number: always the dial code of phoneCountry
  phoneCountry: 'IN', // the country picked for the contact number's code (+1 and +7 are shared)
  ccEdited: false, // true once the person has changed the code by hand
  phone: '',
  care: [], // the ONE chosen care-level key, as a list of 0 or 1; only asked for air & ground ambulance (see needsCareLevel)
  airlineMode: '', // 'stretcher' | 'wheelchair'; only asked for Commercial Airlines
  // Mortal Remains only (see isMortal); `name`/`age`/`gender` are then the deceased's.
  mortalTransfer: '', // (older builds' single choice; no longer asked: see transferScope / transportMode)
  transferScope: '', // Mortal Remains only: 'domestic' | 'international' (never preselected)
  transportMode: '', // Mortal Remains only: 'private_charter' | 'commercial_air_cargo' | 'ground_transportation' (never preselected)
  // Home Healthcare only (see lib/homeHealthcare.js). Every care selection is optional; the Medical History is `desc`, the Service Date is `date`,
  // the flow rate is `oxygenLpm` and the reports are `files`.
  homeAddress: '', // the Complete Home Address, exactly as typed
  homeCaretakers: [], // 'nurse' | 'caretaker', any of them
  homeCareHours: '', // '12_hours' | '24_hours' | ''
  homeCareLevel: '', // 'full_icu' | 'semi_icu' | ''
  homeOxygen: '', // 'yes' | 'no' | '' (not answered)
  relation: '', // the requester's relation to the deceased
  deathPlace: '',
  deathDate: '', // YYYY-MM-DD
  desc: '', // "Condition & diagnosis" ("Details" for Mortal Remains); saved as the request's description
  dest: '',
  date: '',
  files: [], // medical reports: [{ uri, name, mimeType, size }], from the file picker or the camera
  // Medical page (patient transport only: see needsCareLevel). Urgency is asked for every service.
  mobility: '', // 'bedridden' | 'wheelchair' | 'walking'
  equipOxygen: false,
  equipCardiac: false,
  equipVentilator: false,
  teleScope: '', // Teleconsultation only: 'domestic' | 'international' (never preselected)
  teleType: '', // Teleconsultation only: 'online' | 'house_call' (never preselected)
  // Medical Value Travel only (see lib/medicalValueTravel.js). The Medical History is `desc`, the Preferred Treatment Date is `date`, the cities are
  // `location` / `dest` (with originCity / destCity when picked from the suggestions) and the reports are `files`.
  treatmentScope: '', // 'domestic' | 'international' (never preselected)
  specialty: '', // one of MVT_SPECIALTIES
  otherSpecialty: '', // the specialty in the patient's words, only while specialty is 'Other'
  // Marine Medical Safety only (see lib/marineMedicalSafety.js). The Medical History is `desc`, the Date of Service is `date`, the places are `location` / `dest` (with
  // originCity / destCity when picked from the suggestions), the Oxygen flow rate is `oxygenLpm` and the reports are `files`.
  serviceScope: '', // 'domestic' | 'international' (never preselected)
  marineCare: [], // the Critical Level keys chosen (crit_icu, crit_ventilated, crit_tracheostomy, crit_ecmo), in the order chosen; none is valid
  marineOxygen: '', // 'yes' | 'no' | '' (not answered yet: it must be answered before sending)
  // Corporate Medical Solutions only (see lib/corporateMedical.js). The Name of Employee is `name` and the Gender is `gender`.
  corpCompany: '', // Company Name
  corpEmployees: '', // No. of Employees, digits only as typed
  corpProgrammes: [], // the programme keys chosen (any of the seven; at least one is needed)
  corpAny: '', // Any Requirement (optional), as typed
  corpSpecial: '', // Special Requirement (optional), as typed
  corpOfficeAddress: '', // Office Address (the company's complete office address), multiline, as typed; at most 2,000 characters
  corpOfficeCountry: '', // Office Country: the country's name, for display (the COMPANY OFFICE's country, never the patient's)
  corpOfficeCountryIso: '', // its ISO code, which is what is sent. Independent of the phone's country code (cc / phoneCountry)
  address: '', // Teleconsultation only: the Current Address, multiline, as typed
  allergies: '', // Teleconsultation only: Any Allergic Issue? (the Present Medical Issue is `desc`, the House Call's Preferred Visit Date is `date`)
  oxygenLpm: '', // Commercial Air only: the oxygen flow rate (LPM), typed text; asked while equipOxygen is on (see lib/requestForm.js)
  urgency: '', // 'critical_6h' | 'urgent_24h' | 'planned'
  changingService: false, // set while the person is picking another service from the request form
};

export { needsCareLevel };

export function initialsOf(name) {
  return name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
}

export function AppProvider({ children }) {
  // The language: restored (saved choice, else the phone's language, else English) before anything is shown, so no
  // screen ever flashes the wrong language. Starting never writes; only choosing a language does.
  const [lang, setLangState] = useState(DEFAULT_LANGUAGE);
  const [langReady, setLangReady] = useState(false);
  const langRef = useRef(DEFAULT_LANGUAGE);
  const [session, setSession] = useState('patient'); // 'patient' | 'corporate'
  const [profile, setProfile] = useState(INITIAL_PROFILE);
  const [draft, setDraft] = useState(INITIAL_DRAFT);
  // Whether there is a valid session: 'loading' until the saved one has been checked with the server, then
  // 'authed', 'anon' (none, or refused) or 'unreachable' (the server could not be asked). AuthGate reads it.
  const [authStatus, setAuthStatus] = useState('loading');
  const [toastMsg, setToastMsg] = useState(null);
  // The API's field errors from the last refused submission, { apiField: message } or null. Kept
  // apart from the draft so the answers are never touched; changing a field clears its own error.
  const [serverErrors, setServerErrors] = useState(null);
  const toastTimer = useRef(null);

  const t = useCallback((key, values) => translate(I18N, lang, key, values), [lang]);

  useEffect(() => {
    let alive = true;
    resolveInitialLanguage({ storage: AsyncStorage, getLocales }).then((code) => {
      if (!alive) return;
      langRef.current = code;
      setDateLocale(localeOf(code));
      setLangState(code);
      setLangReady(true);
    });
    return () => { alive = false; };
  }, []);

  // Chooses a language: an unknown code or the language already showing does nothing (and writes nothing).
  const setLang = useCallback((code) => {
    if (!isSupportedLanguage(code) || code === langRef.current) return;
    langRef.current = code;
    setDateLocale(localeOf(code));
    setLangState(code);
    saveLanguage(AsyncStorage, code);
  }, []);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2200);
  }, []);

  const updateDraft = useCallback((patch) => {
    setDraft((d) => ({ ...d, ...patch }));
    setServerErrors((errors) => clearErrorsForPatch(errors, patch));
  }, []);

  // The authentication state (lib/authState.js). It becomes 'authed' only when the server accepted the saved
  // session, or has just issued credentials (a login); saving or renewing tokens grants nothing by itself.
  const authStore = useMemo(() => createAuthStore({
    getToken: getAccessToken,
    fetchMe: (signal) => apiGet('/auth/me', { signal, validation: true }),
    onChange: (status, me) => {
      setAuthStatus(status);
      if (status === 'authed' && me) {
        // Loads the real name/email, also after a reload straight onto a protected screen.
        try {
          const restored = profileFromMe(me);
          setProfile(restored.profile);
          setSession(restored.session);
        } catch { /* a profile that cannot be read leaves the session valid; the screens show what they have */ }
      }
    },
  }), []);

  useEffect(() => {
    // Signing in (a login, an account activation) or out (tokens cleared) is announced by lib/session.js.
    // What the screens had loaded is forgotten at every sign-in and sign-out (lib/screenCache.js), so it never shows for another account.
    const unsubscribe = onSessionChange((signedIn) => { clearCache(); return signedIn ? authStore.signedIn() : authStore.signedOut(); });
    Promise.resolve().then(authStore.validate);
    return unsubscribe;
  }, [authStore]);

  const retryAuth = authStore.retry;

  // Pull-to-refresh on Profile: reads the account again. A failure leaves the profile as it was (the caller says so).
  const refreshProfile = useCallback(async () => {
    const data = await apiGet('/auth/me');
    const restored = profileFromMe(data);
    setProfile(restored.profile);
    return restored.profile;
  }, []);

  const value = useMemo(
    () => ({
      lang,
      setLang,
      isRTL: isRtlLanguage(lang),
      locale: localeOf(lang),
      t,
      session,
      setSession,
      authStatus,
      retryAuth,
      isCorporate: session === 'corporate',
      profile,
      setProfile,
      refreshProfile,
      draft,
      updateDraft,
      resetDraft: (service) => { setDraft((d) => draftForService(d, service, INITIAL_DRAFT)); setServerErrors(null); },
      serverErrors,
      setServerErrors,
      toast,
      toastMsg,
    }),
    [lang, setLang, t, session, authStatus, retryAuth, refreshProfile, profile, draft, updateDraft, serverErrors, toast, toastMsg]
  );

  // Nothing is drawn until the language is known (a moment at most); sign-in restoration above keeps running.
  if (!langReady) return null;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  return useContext(AppContext);
}
