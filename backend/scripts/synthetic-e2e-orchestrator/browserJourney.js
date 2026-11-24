// The real browser-based patient journey, driven through the actual HumanCare web UI (the Expo web build of
// apps/mobile) with Playwright: register -> Firebase phone OTP (a Firebase *test* number + its fixed test code,
// typed into the real OTP boxes; Firebase is never bypassed) -> Private Charter request (step 1, step 2, review) ->
// real document upload through the app's own file picker -> submit.
//
// What this module never does: it never calls the backend API directly, never touches the database, never
// contacts Bitrix, never prints or stores the OTP code or the password, and never takes a screenshot on an OTP screen
// (the code boxes are not masked).
//
// Bitrix isolation for the browser, in layers (all must be supplied: without `egress` the journey refuses to start):
//   1. Chromium itself is launched with --proxy-server pointing at the local filtering proxy (egressProxy.js), so every
//      non-loopback request - page loads, redirects, WebSocket upgrades, anything a service worker would do - is vetted
//      by name and by resolved address; --host-resolver-rules maps Bitrix names to NOTFOUND; QUIC and non-proxied WebRTC
//      UDP are disabled so there is no side channel around the proxy.
//   2. Service workers are blocked, so the page cannot register one that issues its own fetches.
//   3. A context route aborts any request to a Bitrix host, and any request to localhost:4000 / :4100 (the normal dev API
//      and the payment E2E runner), and a WebSocket route refuses the same destinations.
//   4. Before the registration form is even opened, a canary navigation to a Bitrix-looking name must fail and must not
//      be allowed through the proxy.
//
// The selectors are the app's own English labels/placeholders (apps/mobile/src/data/i18n.json, EN) and the
// accessibilityLabels in the components. If the UI changes, a step fails with its name and a (non-OTP) screenshot
// rather than guessing.
const fs = require('fs');
const path = require('path');
const { assertNotProtected } = require('./safety');
const { CANARY_HOST } = require('./egressPolicy');

const FORBIDDEN_LOCAL_PORTS = ['4000', '4100'];
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

class JourneyError extends Error {
  constructor(step, message, cause) {
    super(`browser journey failed at step "${step}": ${message}`);
    this.name = 'JourneyError';
    this.step = step;
    this.code = 'journey_failed';
    if (cause) this.cause = cause;
  }
}

// "+917000000001" with dial "+91" -> "7000000001". Only the +91 (India) pool is supported by this journey, because
// the form's default phone country follows the chosen nationality (India).
function splitPhone(e164, dial = '+91') {
  if (!e164.startsWith(dial)) throw new JourneyError('phone', `test number must start with ${dial}`);
  return e164.slice(dial.length);
}

function futureDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

// Pure: the Chromium launch options that route every non-loopback request through the filtering proxy and close the
// side channels around it. `blockedHosts` are the exact Bitrix names to additionally map to NOTFOUND.
function buildLaunchOptions({ proxyUrl, blockedHosts = [], headless = false }) {
  if (!proxyUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(proxyUrl)) throw new JourneyError('setup', 'the egress proxy URL is missing or not a loopback address');
  const mapped = [...new Set([...blockedHosts, CANARY_HOST])].filter(Boolean);
  const rules = ['MAP *.bitrix24.in ~NOTFOUND', 'MAP *.bitrix24.com ~NOTFOUND', 'MAP *.bitrix24.net ~NOTFOUND', 'MAP *.bitrix24.eu ~NOTFOUND', 'MAP *.bitrix24.invalid ~NOTFOUND', ...mapped.map((h) => `MAP ${h} ~NOTFOUND`)];
  return {
    headless,
    proxy: { server: proxyUrl, bypass: 'localhost,127.0.0.1,[::1]' },
    args: [
      `--host-resolver-rules=${rules.join(', ')}`,
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  };
}

// Pure: is this request destination one the journey must never reach?
function forbiddenDestination(url, policy) {
  const host = url.hostname.toLowerCase();
  if (policy.check(host).blocked) return 'bitrix';
  if (LOOPBACK_NAMES.includes(host) && FORBIDDEN_LOCAL_PORTS.includes(url.port)) return 'forbidden_local_port';
  return null;
}

async function runJourney({
  webUrl, identity, phone, testCode, pdfPath, runDir, egress, headless = false, log = console.log, stepTimeoutMs = 30000,
}) {
  if (!egress || !egress.proxyUrl || !egress.policy || !egress.proxy) throw new JourneyError('setup', 'browser egress isolation was not supplied; refusing to open a browser');
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (err) { throw new JourneyError('setup', `playwright is not installed: ${err.message}`); }

  const shots = path.join(runDir, 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  // Prefer the machine's installed Edge/Chrome (no browser download needed); fall back to Playwright's chromium.
  let browser;
  const launchOptions = buildLaunchOptions({ proxyUrl: egress.proxyUrl, blockedHosts: egress.blockedHosts || [], headless });
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { browser = await chromium.launch({ ...launchOptions, ...(channel ? { channel } : {}) }); break; } catch { /* try next */ }
  }
  if (!browser) throw new JourneyError('setup', 'no usable browser (install Edge/Chrome, or run `npx playwright install chromium`)');

  // Canary, BEFORE anything is registered: a throwaway context navigates to a Bitrix-looking name. It must fail, and the
  // proxy must not have let it through. (Whether the browser's resolver rules or the proxy stopped it is not distinguished;
  // either way the name did not leave the machine.)
  {
    const canaryContext = await browser.newContext({ serviceWorkers: 'block' });
    const canaryPage = await canaryContext.newPage();
    let reached = false;
    try {
      await canaryPage.goto(`https://${CANARY_HOST}/`, { timeout: 15000 });
      reached = true;
    } catch { /* expected: the navigation must fail */ }
    await canaryContext.close().catch(() => {});
    if (reached || egress.proxy.stats().allowedHosts.includes(CANARY_HOST)) {
      await browser.close().catch(() => {});
      throw new JourneyError('egress-canary', 'the browser reached a Bitrix-looking canary host; isolation is not effective');
    }
  }

  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: 'block' });
  context.setDefaultTimeout(stepTimeoutMs);
  const blockedBitrix = [];
  const blockedLocal = [];
  await context.route((url) => forbiddenDestination(url, egress.policy) !== null, (route) => {
    const kind = forbiddenDestination(new URL(route.request().url()), egress.policy);
    (kind === 'bitrix' ? blockedBitrix : blockedLocal).push(route.request().method());
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket((url) => forbiddenDestination(url, egress.policy) !== null, (ws) => {
    const kind = forbiddenDestination(new URL(ws.url()), egress.policy);
    (kind === 'bitrix' ? blockedBitrix : blockedLocal).push('WS');
    ws.close({ code: 1008, reason: 'blocked by synthetic E2E isolation' });
  });
  const page = await context.newPage();
  let current = 'start';
  const step = async (name, fn) => {
    current = name;
    log(`[journey] ${name}`);
    try { return await fn(); } catch (err) {
      if (err instanceof JourneyError) throw err;
      await safeShot(`failed-${name.replace(/\W+/g, '-')}`);
      throw new JourneyError(name, String(err.message).split('\n')[0], err);
    }
  };
  async function safeShot(label) {
    try {
      if (/otp/i.test(page.url())) return; // OTP boxes show the code in clear text: never capture them
      await page.screenshot({ path: path.join(shots, `${label}.png`) });
    } catch { /* best effort */ }
  }
  const pick = async (buttonName, optionName) => {
    await page.getByText(buttonName, { exact: true }).first().click();
    await page.getByText(optionName, { exact: true }).last().click();
  };
  const pickCountry = async (triggerName, country) => {
    await page.getByRole('button', { name: triggerName }).first().click();
    await page.getByPlaceholder('Search country or code').fill(country);
    await page.getByRole('button', { name: new RegExp(`^${country},`) }).first().click();
  };
  const pickCity = async (label, text, expectLabel) => {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(text);
    await page.getByRole('button', { name: expectLabel }).first().click();
  };

  try {
    await step('open-register', async () => {
      await page.goto(`${webUrl.replace(/\/$/, '')}/register`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder('First name').waitFor();
    });

    await step('fill-registration', async () => {
      await page.getByPlaceholder('First name').fill(identity.firstName);
      await page.getByPlaceholder('Last name').fill(identity.lastName);
      await pick('Select gender', 'Male');
      await pickCountry(/^Nationality/, 'India');
      await page.getByLabel('Mobile number', { exact: true }).fill(splitPhone(phone));
      await page.getByPlaceholder('you@example.com').fill(identity.email);
      await page.getByPlaceholder('Create a password').fill(identity.password);
      await page.getByPlaceholder('Re-enter your password').fill(identity.password);
      await page.getByText('By submitting the above information', { exact: false }).click(); // the one required consent
    });

    await step('submit-registration', async () => {
      await page.getByText('CREATE ACCOUNT', { exact: true }).click();
      await page.waitForURL(/register-otp/);
    });

    await step('firebase-otp', async () => {
      // Firebase test number: Firebase itself "sends" nothing and accepts only the configured fixed code. The
      // code is typed into the real OTP boxes (paste-style fill handled by the app's OtpInput); never logged.
      const boxes = page.locator('input[type="tel"], input[inputmode="numeric"], input[autocomplete="sms-otp"]');
      const first = (await boxes.count()) ? boxes.first() : page.locator('input').first();
      await first.waitFor();
      await first.click();
      await page.keyboard.type(testCode, { delay: 60 });
      await page.getByText('Verify & Continue', { exact: true }).click();
      await page.waitForURL((u) => !/register-otp/.test(u.toString()), { timeout: 60000 });
    });

    await step('open-private-charter', async () => {
      await page.goto(`${webUrl.replace(/\/$/, '')}/service/privatecharter`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Request This Service', { exact: true }).click(); // fails clearly if the session was lost
      await page.waitForURL(/request\/step1/);
    });

    await step('request-step1', async () => {
      await page.getByPlaceholder("Enter patient's full name").fill(identity.patientName);
      await page.getByPlaceholder('Age').fill('45');
      await pick('Select gender', 'Male');
      await pick('Select travel type', 'Patient Transfer');
      await pickCountry(/^Country,/, 'India');
      await pickCity('Origin City', 'Mumbai', /^Mumbai/);
      await pickCity('Destination City', 'Delhi', /^(New )?Delhi/);
      await page.getByPlaceholder('Enter number').fill(splitPhone(phone));
      await page.locator('input[type="date"]').first().fill(futureDate(14));
      await page.getByText('Continue to medical details', { exact: false }).click();
      await page.waitForURL(/request\/step2/);
    });

    await step('request-step2', async () => {
      await page.getByLabel('Medical History', { exact: true }).fill('SYNTHETIC TEST — no real medical information.');
      await page.getByRole('button', { name: 'ICU', exact: true }).first().click();
      await page.getByRole('button', { name: 'No', exact: true }).first().click(); // Oxygen Required: No
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Add file' }).first().click();
      await (await chooser).setFiles(pdfPath);
      await page.getByText(path.basename(pdfPath), { exact: false }).first().waitFor();
      await page.getByText('Review request', { exact: false }).click();
      await page.waitForURL(/request\/review/);
    });

    const submitted = await step('review-and-submit', async () => {
      await page.getByText('Submit request', { exact: true }).click();
      await page.waitForURL(/request\/submitted/, { timeout: 120000 });
      const url = new URL(page.url());
      const requestId = Number(url.searchParams.get('requestId'));
      if (!Number.isInteger(requestId) || requestId <= 0) throw new JourneyError('review-and-submit', 'the submitted page did not carry a request id');
      assertNotProtected(requestId); // hard stop before anything else is done with this id
      const referenceNumber = url.searchParams.get('id');
      await page.getByText('Thank You!', { exact: false }).first().waitFor();
      await safeShot('submitted');
      return { requestId, referenceNumber };
    });

    if (blockedBitrix.length) throw new JourneyError('bitrix-isolation', `the browser attempted ${blockedBitrix.length} request(s) to the Bitrix host (all aborted)`);
    if (blockedLocal.length) throw new JourneyError('forbidden-api', `the browser attempted ${blockedLocal.length} request(s) to localhost:4000 or :4100 (all aborted); the web build is not using the isolated API`);
    return { ...submitted, usedRealUi: true, firebaseTestAuth: true, bitrixRequestsBlockedInBrowser: blockedBitrix.length, forbiddenLocalRequestsBlocked: blockedLocal.length };
  } catch (err) {
    await safeShot(`final-${current}`);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runJourney, JourneyError, splitPhone, futureDate, buildLaunchOptions, forbiddenDestination };
