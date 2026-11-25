import { apiGet } from './api';
import { toListItem } from './requestShape';
import { setCached } from './screenCache';

// The patient's request list, loaded ONE way for the two tabs that show it (My Requests and Tracking): the same cache key, so what one tab loaded is on screen at once in the other and is refreshed
// quietly (lib/useResource.js, lib/screenCache.js), and the same fetcher, so both read the same list items. The cache is cleared when the person signs out or in (state/AppContext.js), so one account's
// requests never show for the next.
export const MY_REQUESTS_KEY = 'my-requests';
export const fetchMyRequests = () => apiGet('/requests/me').then(({ requests }) => requests.map(toListItem));
export const idsOfRequests = (list) => list.map((r) => r.rawId);

// How long the list that Home (or the other tab) just loaded is good enough for the two tabs to skip their OPENING load (useResource `freshMs`). A pull, "Try again", a quiet refresh when a tab
// comes back into front and a connection restored all ask the server regardless.
export const MY_REQUESTS_FRESH_MS = 10 * 1000;

// Home reads the same list (with the unread-notification dot in the same load). When that succeeds it stores the list for the two tabs, so opening them the first time needs no second call and no
// skeleton. `epoch` is lib/screenCache.js sessionEpoch() read BEFORE Home's load started: a list that arrives after a sign-out or an account switch is not stored.
export const seedMyRequests = (requests, epoch) => setCached(MY_REQUESTS_KEY, requests.map(toListItem), { epoch });
