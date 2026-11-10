// Turns whatever an error response carried into a plain object, so callers can read `error`,
// `code` and extra fields such as the approval `blockers`. Pure and DOM-free so it can be
// unit-tested with `node --test`.
//
// A request made with `responseType: 'blob'` (a document download) delivers even its JSON
// error body as a Blob, so that case has to be read and parsed first.
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves with the error body as a plain object, or undefined when there is none. */
export async function readErrorBody(data) {
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    try {
      return parseJsonObject(await data.text());
    } catch {
      return undefined;
    }
  }
  if (typeof data === 'string') return parseJsonObject(data);
  return isObject(data) ? data : undefined;
}

/** The message to show: the server's own `error` when it sent one, otherwise a generic line. */
export function errorMessage(body, status) {
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return status === 0
    ? 'Unable to reach the server. Check your connection and try again.'
    : 'Something went wrong. Please try again.';
}
