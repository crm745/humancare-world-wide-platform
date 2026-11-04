// Passkey ceremonies with the browser's own WebAuthn API. `@simplewebauthn/browser` is not a
// dependency of this app, so this does the small amount of work it would do: base64url <-> bytes
// and the JSON shapes the backend (which uses @simplewebauthn/server) expects.
//
// What this module guarantees:
//  - User verification is never weakened. The options come from the server with
//    userVerification "required"; anything else is refused rather than passed on, and nothing here
//    overrides, defaults or downgrades it.
//  - Nothing is logged, stored or kept. Challenges, credential ids and attestations pass through
//    the call and are gone; errors are reduced to a code and a fixed message, never the browser's
//    own text.
//  - Only the fields the backend reads are sent (it copies those and drops the rest anyway).

export class WebAuthnError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebAuthnError';
    this.code = code;
  }
}

// Fixed, user-facing text per failure. `unsupported` and `insecure` are not the user's doing;
// `cancelled` is the browser's NotAllowedError, which covers cancel, timeout and "no matching key".
export const WEBAUTHN_MESSAGES = {
  unsupported: "This browser can't use passkeys. Use a current version of Chrome, Edge, Safari or Firefox.",
  insecure: "Passkeys only work on a secure (HTTPS) address, and this page isn't on one.",
  cancelled: 'The passkey prompt was cancelled or timed out. Try again when you are ready.',
  already_registered: 'This device already has a passkey for your account. Use a different security key or device.',
  not_supported_device: "This device can't create the kind of passkey required. Try another device or a security key.",
  invalid_options: "The server's passkey request was not valid. Please start again.",
  failed: 'The passkey step could not be completed. Please try again.',
};

const fail = (code) => new WebAuthnError(code, WEBAUTHN_MESSAGES[code]);

const B64URL = /^[A-Za-z0-9_-]*$/;

export function base64urlToBytes(value) {
  if (typeof value !== 'string' || !B64URL.test(value)) throw fail('invalid_options');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isWebAuthnSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials &&
    typeof navigator.credentials.create === 'function' &&
    typeof navigator.credentials.get === 'function'
  );
}

function assertUsable() {
  if (!isWebAuthnSupported()) throw fail('unsupported');
  if (window.isSecureContext === false) throw fail('insecure');
}

const descriptor = (d) => ({
  type: 'public-key',
  id: base64urlToBytes(d.id),
  ...(Array.isArray(d.transports) ? { transports: d.transports } : {}),
});

function creationOptions(json) {
  if (!json || typeof json !== 'object' || !json.rp || !json.user || json.authenticatorSelection?.userVerification !== 'required') {
    throw fail('invalid_options');
  }
  return {
    publicKey: {
      rp: json.rp,
      user: { id: base64urlToBytes(json.user.id), name: json.user.name, displayName: json.user.displayName },
      challenge: base64urlToBytes(json.challenge),
      pubKeyCredParams: json.pubKeyCredParams,
      timeout: json.timeout,
      excludeCredentials: (json.excludeCredentials || []).map(descriptor),
      authenticatorSelection: json.authenticatorSelection,
      attestation: json.attestation,
    },
  };
}

function requestOptions(json) {
  if (!json || typeof json !== 'object' || !json.rpId || json.userVerification !== 'required') throw fail('invalid_options');
  return {
    publicKey: {
      rpId: json.rpId,
      challenge: base64urlToBytes(json.challenge),
      timeout: json.timeout,
      allowCredentials: (json.allowCredentials || []).map(descriptor),
      userVerification: json.userVerification,
    },
  };
}

// The browser's reasons, reduced to our codes. The browser's message text is never used.
function explain(err, ceremony) {
  if (err instanceof WebAuthnError) return err;
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'AbortError':
      return fail('cancelled');
    case 'InvalidStateError':
      return fail(ceremony === 'create' ? 'already_registered' : 'failed');
    case 'NotSupportedError':
      return fail(ceremony === 'create' ? 'not_supported_device' : 'unsupported');
    case 'SecurityError':
      return fail('insecure');
    default:
      return fail('failed');
  }
}

/** Registers a passkey for the server's creation options. Resolves with the JSON the backend verifies. */
export async function createPasskey(optionsJSON, { signal } = {}) {
  assertUsable();
  let credential;
  try {
    credential = await navigator.credentials.create({ ...creationOptions(optionsJSON), signal });
  } catch (err) {
    throw explain(err, 'create');
  }
  if (!credential || !credential.response) throw fail('failed');
  const { response } = credential;
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : undefined;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      attestationObject: bytesToBase64url(response.attestationObject),
      ...(Array.isArray(transports) && transports.length > 0 ? { transports } : {}),
    },
  };
}

/** Answers the server's request options (sign-in or an approval step-up) with an existing passkey. */
export async function getPasskeyAssertion(optionsJSON, { signal } = {}) {
  assertUsable();
  let credential;
  try {
    credential = await navigator.credentials.get({ ...requestOptions(optionsJSON), signal });
  } catch (err) {
    throw explain(err, 'get');
  }
  if (!credential || !credential.response) throw fail('failed');
  const { response } = credential;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      authenticatorData: bytesToBase64url(response.authenticatorData),
      signature: bytesToBase64url(response.signature),
      ...(response.userHandle && response.userHandle.byteLength > 0 ? { userHandle: bytesToBase64url(response.userHandle) } : {}),
    },
  };
}
