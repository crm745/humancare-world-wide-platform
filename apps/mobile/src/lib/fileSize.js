// The 10 MB limit on a file the person attaches, applied the same way to every source of a file (the camera, the document picker, a file added to an existing request) and, as a last check,
// to every upload. Pure (no React, no native modules): the one place that reads a size is injected (lib/fileSizeDevice.js), so every rule here is unit-tested.
//
// Why: the camera and the pickers report a size only sometimes (ImagePicker's `fileSize` and DocumentPicker's `size` are optional, and a bad value such as 0, NaN or a text can arrive), and the
// old check `file.size && file.size > MAX` treated "no size" as "fine", so a big file could skip the check and only be refused by the server after being sent.
//   known size       a finite whole number of bytes, 0 or more (a numeric text such as "2048" counts; NaN, Infinity, negative, fractions and anything else do not)
//   size not given   the size is READ from the file (resolveFileSize); a size that cannot be read stays unknown
//   verdict          'ok' (1 byte up to exactly 10 MB), 'too_big' (over 10 MB), 'empty' (0 bytes: the server refuses these too), 'unknown'
//   unknown          the file is accepted by the form (nothing is known against it, and a valid file must not be refused for a missing number), and it is still held to 10 MB by the server
//                    (and shown the translated refusal if it is too big); apiUpload also stops any file whose size IS known to be over the limit.
import { MAX_REPORT_BYTES } from '../data/mock';
import { uploadAnswered } from './uploadErrors';

export const MAX_UPLOAD_BYTES = MAX_REPORT_BYTES;
export const FILE_TOO_BIG_MESSAGE = 'The file is larger than 10 MB.'; // the backend's own wording (lib/serverErrors.js recognises it and shows it in the person's language)

// A size in bytes, or null when the value is not a usable size.
export function knownSize(value) {
  if (typeof value === 'number') return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

// 'ok' | 'too_big' | 'empty' | 'unknown' for a size that may not be known.
export function sizeVerdict(size, max = MAX_UPLOAD_BYTES) {
  const bytes = knownSize(size);
  if (bytes === null) return 'unknown';
  if (bytes === 0) return 'empty';
  return bytes > max ? 'too_big' : 'ok';
}

// The size of a picked file: the one the picker gave when it is usable, else read from the file by `readSize(uri)` (which may throw, answer null or answer rubbish). Never throws.
export async function resolveFileSize(file, readSize) {
  const given = knownSize(file && file.size);
  // A given size of 0 is not trusted on its own: some pickers report 0 for "unknown", so the file is read once more before it is called empty.
  if (given !== null && given > 0) return given;
  if (!file || typeof file.uri !== 'string' || typeof readSize !== 'function') return given;
  try {
    const read = knownSize(await readSize(file.uri));
    return read !== null ? read : given;
  } catch {
    return given;
  }
}

// The file with its size filled in (`size` is a number, or null when unknown). The rest of the file is untouched.
export async function withResolvedSize(file, readSize) {
  const size = await resolveFileSize(file, readSize);
  return { ...file, size };
}

// The refusal apiUpload throws, before anything is sent, for a file known to be over the limit: the same shape and wording as the server's refusal, so the upload list shows it translated.
// null for every other file.
export function oversizedUploadError(file) {
  return sizeVerdict(file && file.size) === 'too_big' ? uploadAnswered(400, { error: FILE_TOO_BIG_MESSAGE, code: 'file_too_large' }) : null;
}

// One picked file, checked: { file, problem } where problem is null (accept), 'type' (not an allowed type), 'too_big' or 'empty'. The size is resolved first (see above), so the same checks
// run whether or not the picker gave one. `file` carries the resolved size (a number, or null when unknown).
export async function vetPickedFile(file, readSize, allowedTypes) {
  if (file.mimeType && !allowedTypes.includes(file.mimeType)) return { file, problem: 'type' };
  const sized = await withResolvedSize(file, readSize);
  const verdict = sizeVerdict(sized.size);
  if (verdict === 'too_big') return { file: sized, problem: 'too_big' };
  if (verdict === 'empty') return { file: sized, problem: 'empty' };
  return { file: sized, problem: null };
}
