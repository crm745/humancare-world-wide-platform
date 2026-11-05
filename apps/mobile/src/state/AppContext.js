import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import I18N from '../data/i18n.json';
import { apiGet } from '../lib/api';
import { getAccessToken } from '../lib/session';
import { profileFromUser } from '../lib/profile';
import { draftForService, needsCareLevel } from '../lib/requestForm';

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
  extra: '',
  special: '',
  source: '',
  sourceOther: '', // free text when source is "Other"
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
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimer = useRef(null);

  const t = useCallback((key) => (I18N[lang] && I18N[lang][key]) ?? I18N.EN[key] ?? key, [lang]);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2200);
  }, []);

  const updateDraft = useCallback((patch) => setDraft((d) => ({ ...d, ...patch })), []);

  // Runs on every app/provider mount — not just the splash screen's — so a saved
  // session still gets a real name/email loaded even when the browser is reloaded
  // (or the app re-launched) directly on an already-authenticated screen like Home,
  // not just when the user walks through Splash first.
  useEffect(() => {
    (async () => {
      const token = await getAccessToken();
      if (!token) return;
      try {
        const data = await apiGet('/auth/me');
        const restored = profileFromMe(data);
        setProfile(restored.profile);
        setSession(restored.session);
      } catch {
        // Invalid/expired session — apiFetch already clears the tokens and redirects
        // to Welcome on an unrecoverable 401, nothing more to do here.
      }
    })();
  }, []);

  const value = useMemo(
    () => ({
      lang,
      setLang,
      isRTL: lang === 'AR',
      t,
      session,
      setSession,
      isCorporate: session === 'corporate',
      profile,
      setProfile,
      draft,
      updateDraft,
      resetDraft: (service) => setDraft((d) => draftForService(d, service, INITIAL_DRAFT)),
      toast,
      toastMsg,
    }),
    [lang, t, session, profile, draft, updateDraft, toast, toastMsg]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  return useContext(AppContext);
}
