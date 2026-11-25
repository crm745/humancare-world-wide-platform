// The one source of secure random identifiers on the phone: expo-crypto's native random UUID (a v4 UUID from the operating system's secure generator), lower-case. Used for every
// id the app sends so the server can recognise a retry: the request's `clientRequestId` (Phase 4, lib/submissionKey.js) and each file's `clientUploadId` (Phase 5,
// lib/uploadRecovery.js). Neither is a secret; they only have to be unique. The format is the same one the earlier code made, so ids already stored on a phone stay valid.
import * as Crypto from 'expo-crypto';

export const secureUuid = () => String(Crypto.randomUUID()).toLowerCase();
