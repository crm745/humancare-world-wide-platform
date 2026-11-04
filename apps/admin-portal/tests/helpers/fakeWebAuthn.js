// A stand-in for the browser's WebAuthn API, so mocked browser tests can run the passkey ceremonies
// without a real authenticator. It is installed before the app loads and records what the app asked
// for (so tests can check that user verification stayed "required" and that challenges arrive as
// bytes), then answers with deterministic fake credentials.
//
// Tests steer it from the page:  window.__webauthn.mode = 'ok' | <DOMException name>
// ('NotAllowedError' = cancelled, 'InvalidStateError' = already registered, ...), or 'hang' to
// leave the browser prompt open.
// Nothing here talks to a server or touches a real credential.

/** @param {import('@playwright/test').BrowserContext} context */
async function installFakeWebAuthn(context, { supported = true } = {}) {
  await context.addInitScript((isSupported) => {
    const buf = (n, fill) => new Uint8Array(n).fill(fill).buffer;
    const state = { mode: 'ok', calls: [] };
    window.__webauthn = state;

    const fake = {
      async create(opts) {
        const pk = opts.publicKey;
        state.calls.push({
          type: 'create',
          userVerification: pk.authenticatorSelection && pk.authenticatorSelection.userVerification,
          challengeIsBytes: pk.challenge instanceof Uint8Array,
          userIdIsBytes: pk.user.id instanceof Uint8Array,
          excludeIds: (pk.excludeCredentials || []).map((c) => c.id instanceof Uint8Array),
        });
        if (state.mode === 'hang') return new Promise(() => {}); // the prompt stays open
        if (state.mode !== 'ok') throw new DOMException('fake', state.mode);
        return {
          id: 'ZmFrZS1jcmVkZW50aWFs',
          rawId: buf(16, 1),
          type: 'public-key',
          response: { clientDataJSON: buf(40, 2), attestationObject: buf(60, 3), getTransports: () => ['internal'] },
        };
      },
      async get(opts) {
        const pk = opts.publicKey;
        state.calls.push({
          type: 'get',
          userVerification: pk.userVerification,
          challengeIsBytes: pk.challenge instanceof Uint8Array,
          rpId: pk.rpId,
          allowIds: (pk.allowCredentials || []).map((c) => c.id instanceof Uint8Array),
        });
        if (state.mode === 'hang') return new Promise(() => {}); // the prompt stays open
        if (state.mode !== 'ok') throw new DOMException('fake', state.mode);
        return {
          id: 'ZmFrZS1jcmVkZW50aWFs',
          rawId: buf(16, 1),
          type: 'public-key',
          response: { clientDataJSON: buf(40, 4), authenticatorData: buf(37, 5), signature: buf(70, 6), userHandle: buf(32, 7) },
        };
      },
    };

    if (isSupported) {
      Object.defineProperty(navigator, 'credentials', { value: fake, configurable: true });
      if (typeof window.PublicKeyCredential !== 'function') window.PublicKeyCredential = function PublicKeyCredential() {};
    } else {
      Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
      Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
    }
  }, supported);
}

module.exports = { installFakeWebAuthn };
