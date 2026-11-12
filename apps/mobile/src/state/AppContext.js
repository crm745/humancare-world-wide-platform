import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import I18N from '../data/i18n.json';
import { apiGet } from '../lib/api';
import { getAccessToken, onSessionChange } from '../lib/session';
import { createAuthStore } from '../lib/authState';
import { profileFromUser } from '../lib/profile';
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
  care: [], // care-level keys, one or more; only asked for air & ground ambulance (see needsCareLevel)
  airlineMode: '', // 'stretcher' | 'wheelchair'; only asked for Commercial Airlines
  // Mortal Remains only (see isMortal); `name`/`age`/`gender` are then the deceased's.
  mortalTransfer: '', // 'domestic' | 'international'
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
  urgency: '', // 'critical_6h' | 'urgent_24h' | 'planned'
  changingService: false, // set while the person is picking another service from the request form
};

export { needsCareLevel };

export function initialsOf(name) {
  return name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
}

export function AppProvider({ children }) {
  const [lang, setLang] = useState('EN');
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

  const t = useCallback((key) => (I18N[lang] && I18N[lang][key]) ?? I18N.EN[key] ?? key, [lang]);

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
    const unsubscribe = onSessionChange((signedIn) => (signedIn ? authStore.signedIn() : authStore.signedOut()));
    Promise.resolve().then(authStore.validate);
    return unsubscribe;
  }, [authStore]);

  const retryAuth = authStore.retry;

  const value = useMemo(
    () => ({
      lang,
      setLang,
      isRTL: lang === 'AR',
      t,
      session,
      setSession,
      authStatus,
      retryAuth,
      isCorporate: session === 'corporate',
      profile,
      setProfile,
      draft,
      updateDraft,
      resetDraft: (service) => { setDraft((d) => draftForService(d, service, INITIAL_DRAFT)); setServerErrors(null); },
      serverErrors,
      setServerErrors,
      toast,
      toastMsg,
    }),
    [lang, t, session, authStatus, retryAuth, profile, draft, updateDraft, serverErrors, toast, toastMsg]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  return useContext(AppContext);
}
