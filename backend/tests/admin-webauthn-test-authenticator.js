// A software "authenticator" for tests: builds genuine WebAuthn registration responses
// (attestation "none") that the real @simplewebauthn/server can verify. Not a test file.
const crypto = require('crypto');
const { isoCBOR, isoBase64URL } = require('@simplewebauthn/server/helpers');

const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

// Each returns { cose, privateKey, alg } so a registered credential can later sign assertions.
function ecCoseKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  return { cose, privateKey, alg: 'es256' };
}

function rsaCoseKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]]);
  return { cose, privateKey, alg: 'rs256' };
}

function edCoseKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]]);
  return { cose, privateKey, alg: 'eddsa' };
}

// Options (all optional):
//   challenge   base64url challenge to put in clientDataJSON (use options.challenge)
//   origin, rpId, type   what the browser reports / the RP the authenticator scoped to
//   flags       authenticator flags byte (default UP | UV | AT)
//   counter     signature counter (default 0)
//   credentialId  Buffer (default 32 random bytes)
//   key         'es256' (default) | 'rs256' | 'eddsa' | a COSE Map
//   aaguid      16-byte Buffer (default random)
//   transports  array placed in response.transports (default ['internal']; null leaves it out)
//   fmt, attStmt  attestation format (default 'none', empty statement)
function makeRegistrationResponse({
  challenge,
  origin = 'http://localhost:3000',
  rpId = 'localhost',
  type = 'webauthn.create',
  flags = FLAG.UP | FLAG.UV | FLAG.AT,
  counter = 0,
  credentialId = crypto.randomBytes(32),
  key = 'es256',
  aaguid = crypto.randomBytes(16),
  transports = ['internal'],
  fmt = 'none',
  attStmt = new Map(),
} = {}) {
  const generated = key instanceof Map ? { cose: key, privateKey: null, alg: null } : { es256: ecCoseKey, rs256: rsaCoseKey, eddsa: edCoseKey }[key]();
  const coseKey = generated.cose;
  const publicKey = Buffer.from(isoCBOR.encode(coseKey));
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    crypto.createHash('sha256').update(rpId).digest(),
    Buffer.from([flags]),
    counterBytes,
    aaguid,
    idLength,
    credentialId,
    publicKey,
  ]);
  const attestationObject = Buffer.from(isoCBOR.encode(new Map([['fmt', fmt], ['attStmt', attStmt], ['authData', authData]])));
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const id = isoBase64URL.fromBuffer(credentialId);
  return {
    credentialId,
    publicKey,
    aaguid,
    privateKey: generated.privateKey,
    alg: generated.alg,
    response: {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        ...(transports === null ? {} : { transports }),
      },
    },
  };
}

// A genuine assertion (navigator.credentials.get) from a credential produced by makeRegistrationResponse
// (pass its result as `registered`). Options: challenge, origin, rpId, type, flags (default UP|UV),
// counter (default 1), userHandle (a Buffer/string placed in the response, if given), and
// `signWith` (another private key, to produce a bad signature).
function makeAssertionResponse({
  challenge,
  registered,
  origin = 'http://localhost:3000',
  rpId = 'localhost',
  type = 'webauthn.get',
  flags = FLAG.UP | FLAG.UV,
  counter = 1,
  userHandle,
  signWith,
}) {
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), counterBytes]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const signedData = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const key = signWith || registered.privateKey;
  const signature = registered.alg === 'rs256' ? crypto.sign('sha256', signedData, key) : crypto.sign('sha256', signedData, { key, dsaEncoding: 'der' });
  const id = registered.response.id;
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
      ...(userHandle === undefined ? {} : { userHandle: Buffer.from(userHandle).toString('base64url') }),
    },
  };
}

module.exports = { makeRegistrationResponse, makeAssertionResponse, FLAG };
