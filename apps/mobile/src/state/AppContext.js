import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import I18N from '../data/i18n.json';
import { DEFAULT_LANGUAGE, isRtlLanguage, isSupportedLanguage, localeOf } from '../data/languages';
import { setDateLocale } from '../lib/dateFormat';
import { setCountryLanguage } from '../lib/countryNames';
import { resolveInitialLanguage, saveLanguage } from '../lib/languagePreference';
import { translate } from '../lib/translate';
import { apiGet } from '../lib/api';
import { getAccessToken, onSessionChange } from '../lib/session';
import { createAuthStore } from '../lib/authState';
import { createRestoreRetrier } from '../lib/authRestore';
import { useNetwork } from './NetworkContext';
import { profileFromUser } from '../lib/profile';
import { clearCache } from '../lib/screenCache';
import { currentAccountId, submissionTracker } from '../lib/pendingSubmissionStore';
import { draftStore, draftsSupported, flushOnBackground, makeDraftManager } from '../lib/draftStoreDevice';
import { sessionChangeHandler } from '../lib/submissionKey';
import { draftForService, needsCareLevel } from '../lib/requestForm';
import { clearErrorsForPatch } from '../lib/privateCharter';
import { toastDuration } from '../lib/openLink';

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
  uploadErrors: {}, // { uri: message } for the files the server REFUSED on the last attempt
  uploadUnknown: {}, // { uri: message } for the files whose answer never arrived: the server may have them (Phase 5, lib/uploadRecovery.js)
  originCity: null, // Private Charter: the city for Origin City: picked from GeoNames { geonameId, name, label, countryCode }, or typed by hand { manual: true, name, label, countryCode }
  destCity: null, // Private Charter: the same for Destination City
  country: '', // the country's name, as it is sent to the backend
  countryIso: '', // its ISO code, which the phone code follows (see pickRequestCountry)
  cc: '+91', // the calling code sent with the contact number: always the dial code of phoneCountry
  phoneCountry: 'IN', // the country picked for the contact number's code (+1 and +7 are shared)
  ccEdited: false, // true once the person has changed the code by hand
  phone: '',
  care: [], // the chosen care-level keys: one or more for Private Charter ('care_na' only on its own), at most one for the other transport services (see needsCareLevel)
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
  mobility: [], // chosen keys of 'bedridden' | 'wheelchair' | 'walking': one or more for Private Charter, at most one for the other transport services
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
  // Private Charter only (revised form): replace care level, mobility, on-board equipment and urgency for that service.
  travelType: '', // 'patient_transfer' | 'organ_transfer'
  criticalLevel: [], // multi-select: any of 'icu' | 'ventilated' | 'tracheostomy' | 'ecmo'; at least one is required
  oxygenRequired: null, // true | false; null until answered
  oxygenFlowLpm: '', // text; only meaningful (and only sent) when oxygenRequired is true
  changingService: false, // set while the person is picking another service from the request form
};

export { needsCareLevel };

// Phase 6: the one writer of encrypted drafts (lib/draftManager.js). It saves the form's whitelisted answers a moment after each change, for the signed-in account only.
const draftManager = makeDraftManager(INITIAL_DRAFT);

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
  // Whether credentials are SAVED on this device: null = not known yet (or unreadable), true, false. Only used to tell a returning person whose session could not be
  // validated from a new one (the splash and the Can't Connect screen). It grants nothing: only `authed` does (lib/authState.js).
  const [savedSession, setSavedSession] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  // The API's field errors from the last refused submission, { apiField: message } or null. Kept
  // apart from the draft so the answers are never touched; changing a field clears its own error.
  const [serverErrors, setServerErrors] = useState(null);
  const toastTimer = useRef(null);
  // Phase 6 (encrypted drafts): the saved draft's summary (never its answers), why one was discarded, the form step on screen, and whose form is in memory.
  const [savedDraft, setSavedDraft] = useState(null); // null | { service, step, savedAt, expiresAt }
  const [formStep, setFormStep] = useState(null); // 1..3 while the request form is open; null before a form is started
  const formAccountRef = useRef(null);

  const t = useCallback((key, values) => translate(I18N, lang, key, values), [lang]);

  useEffect(() => {
    let alive = true;
    resolveInitialLanguage({ storage: AsyncStorage, getLocales }).then((code) => {
      if (!alive) return;
      langRef.current = code;
      setDateLocale(localeOf(code));
      setCountryLanguage(code);
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
    setCountryLanguage(code);
    setLangState(code);
    saveLanguage(AsyncStorage, code);
  }, []);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), toastDuration(msg)); // long enough to read: 2.2 s for a short message, up to 7 s for a long one
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
    onSavedSession: setSavedSession,
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
    // The unresolved request keys follow the account: a sign-out or an expired session clears none, the same account signing in finds them, another account finds none (lib/submissionKey.js).
    const trackerSession = sessionChangeHandler(submissionTracker);
    const unsubscribe = onSessionChange((signedIn) => { clearCache(); trackerSession(signedIn); return signedIn ? authStore.signedIn() : authStore.signedOut(); });
    Promise.resolve().then(authStore.validate);
    return unsubscribe;
  }, [authStore]);

  const retryAuth = authStore.retry;

  // Phase 6. The form in memory belongs to one account: when a DIFFERENT account signs in, it is dropped (and nothing of the previous account's saved draft is ever shown to it).
  // The same account signing in again keeps it (and finds its saved draft: Resume).
  function noteAccount(id) {
    draftManager.setAccount(id); // a different account invalidates every waiting or running save of the previous one (lib/draftManager.js)
    if (formAccountRef.current && id && formAccountRef.current !== id) {
      draftManager.reset(false);
      setDraft(INITIAL_DRAFT); setFormStep(null); setServerErrors(null); setSavedDraft(null);
    }
    if (id) formAccountRef.current = id;
  }

  useEffect(() => onSessionChange((signedIn) => {
    if (signedIn) Promise.resolve(currentAccountId()).then(noteAccount, () => undefined); // another account never inherits the form in memory
    else setSavedDraft(null); // signed out (explicit or expired): what is saved stays saved for its owner and is not shown to anyone else
  }), []);

  // Reads the signed-in account's saved draft (an expired or unusable one is deleted by the store, and the person is told). Starting the app, signing in and Home call this.
  const refreshSavedDraft = useCallback(async () => {
    if (!draftsSupported) { setSavedDraft(null); return null; }
    try {
      const id = await currentAccountId();
      noteAccount(id);
      const found = await draftStore.load(id, INITIAL_DRAFT);
      if (found.status === 'ok') { setSavedDraft({ service: found.service, step: found.step, savedAt: found.savedAt, expiresAt: found.expiresAt }); return found; }
      setSavedDraft(null); // an expired or unreadable draft was deleted quietly: there is nothing to show for it
    } catch { setSavedDraft(null); }
    return null;
  }, []);

  useEffect(() => {
    if (authStatus === 'authed' && session === 'patient') Promise.resolve().then(refreshSavedDraft);
  }, [authStatus, session, refreshSavedDraft]);

  // Saves the form a moment after each change: only while a patient is signed in and a request form is open. Never a network call.
  useEffect(() => {
    if (authStatus !== 'authed' || session !== 'patient' || formStep === null || !draftsSupported) return;
    draftManager.schedule(draft, formStep);
  }, [draft, formStep, authStatus, session]);

  // Going to the background writes what is waiting at once (the app may be killed there).
  useEffect(() => flushOnBackground(draftManager), []);
  // After a restart: an unresolved request submission is read back from its encrypted record (nothing is sent; the Review screen asks the server before anything is sent).
  useEffect(() => { if (authStatus === 'authed' && session === 'patient') submissionTracker.restore().catch(() => undefined); }, [authStatus, session]);

  // Resume: restores the saved answers and step into the form. It asks the server for nothing and sends nothing: the person still goes through the steps and Submit.
  // Returns { service, step } to open, or null when there is nothing usable.
  const resumeDraft = useCallback(async () => {
    const id = await currentAccountId();
    const found = await draftStore.load(id, INITIAL_DRAFT);
    if (found.status !== 'ok') {
      setSavedDraft(null);
      return null;
    }
    formAccountRef.current = id;
    draftManager.reset(true);
    setDraft({ ...INITIAL_DRAFT, ...found.values, service: found.service, changingService: false });
    setServerErrors(null);
    setFormStep(found.step);
    submissionTracker.startNew(); // a new submission gets a NEW idempotency key, unless an earlier one is unresolved: that one is kept, and Review asks the server about it before anything is sent
    return { service: found.service, step: found.step };
  }, []);

  // Discard: deletes the saved draft and its key.
  const discardDraft = useCallback(async () => {
    const id = await currentAccountId();
    await draftManager.discard(id);
    setSavedDraft(null);
    setFormStep(null); // a submitted or discarded form is never saved again
  }, []);

  // Explicit sign-out and account deletion: the saved draft, its key and the form in memory go, BEFORE the tokens are cleared (the account is read from them).
  const clearDraftEverywhere = useCallback(async () => {
    try { await draftManager.discard(await currentAccountId()); } catch { /* nothing to delete is the same as deleted */ }
    draftManager.reset(false);
    formAccountRef.current = null;
    setSavedDraft(null); setFormStep(null); setDraft(INITIAL_DRAFT); setServerErrors(null);
    submissionTracker.startNew();
  }, []);

  // When the connection comes back, a session the server could not validate is checked again ONCE, debounced (lib/authRestore.js). It only asks the server again:
  // nothing is trusted, cleared or granted by it, and a refused session still ends through the existing sign-out in api.js.
  const net = useNetwork();
  const retrier = useMemo(() => createRestoreRetrier({ retry: () => authStore.retry() }), [authStore]);
  useEffect(() => { retrier.observeAuth(authStatus); }, [retrier, authStatus]);
  useEffect(() => { retrier.observeNetwork({ status: net.status, restoredCount: net.restoredCount }); }, [retrier, net.status, net.restoredCount]);
  useEffect(() => () => retrier.dispose(), [retrier]);

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
      savedSession,
      retryAuth,
      isCorporate: session === 'corporate',
      profile,
      setProfile,
      refreshProfile,
      draft,
      updateDraft,
      resetDraft: (service) => { setDraft((d) => draftForService(d, service, INITIAL_DRAFT)); setFormStep(null); draftManager.reset(false); setServerErrors(null); submissionTracker.startNew(); }, // a new submission gets a NEW idempotency key
      savedDraft,
      setFormStep,
      refreshSavedDraft,
      resumeDraft,
      discardDraft,
      clearDraftEverywhere,
      serverErrors,
      setServerErrors,
      toast,
      toastMsg,
    }),
    [lang, setLang, t, session, authStatus, savedSession, retryAuth, refreshProfile, profile, draft, updateDraft, serverErrors, toast, toastMsg, savedDraft, refreshSavedDraft, resumeDraft, discardDraft, clearDraftEverywhere]
  );

  // Nothing is drawn until the language is known (a moment at most); sign-in restoration above keeps running.
  if (!langReady) return null;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  return useContext(AppContext);
}
