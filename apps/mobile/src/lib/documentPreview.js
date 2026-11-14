// Opening a document: the rules, in one place. Pure (no React, no native modules), so they can be unit-tested.
//
// Tapping a document opens the in-app preview screen (app/document-preview.js). It NEVER opens the phone's share sheet: sharing happens only when
// the person taps the Share button inside the preview.
//
// What can be previewed: images (jpg, jpeg, png, webp, gif) and PDF. Anything else (Word, text, ...) is 'unsupported': the preview says so and
// offers Share, which is the intentional way to save it or open it in another app.

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
export const PDF_EXTENSIONS = ['pdf'];
export const PREVIEW_ROUTE = '/document-preview';

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};

export const extensionOf = (name) => {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(String(name == null ? '' : name).trim());
  return match ? match[1].toLowerCase() : '';
};

// 'image' | 'pdf' | 'unsupported'. The file name decides; a mime type decides only when the name has no usable extension.
export function previewKind(name, mimeType) {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (PDF_EXTENSIONS.includes(ext)) return 'pdf';
  if (ext) return 'unsupported';
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) return 'image';
  return 'unsupported';
}

// The type to hand to the viewer / the share sheet, or 'application/octet-stream' for a file we do not know.
export const mimeTypeFor = (name) => MIME_BY_EXTENSION[extensionOf(name)] || 'application/octet-stream';

// A second tap that arrives within this long of the first is the same tap (a double tap): it opens nothing more.
export const DOUBLE_TAP_MS = 800;
export function createTapGuard(now = Date.now) {
  let last = -Infinity;
  return {
    allow() {
      const at = now();
      if (at - last < DOUBLE_TAP_MS) return false;
      last = at;
      return true;
    },
  };
}

// The route to open for a document, or null when it has no usable id. `id` is the document's own id; the file is fetched from
// GET /documents/:id/file with the person's sign-in (the backend decides who may read it), never from a link that is in the page.
export function previewTarget(doc) {
  if (!doc || doc.id === null || doc.id === undefined || String(doc.id).trim() === '') return null;
  return { pathname: PREVIEW_ROUTE, params: { id: String(doc.id), name: String(doc.name == null ? '' : doc.name) } };
}

const sharedGuard = createTapGuard();

// The one way a document is opened (Request Details, My Documents): pushes the preview. `push` is router.push. Returns whether it opened.
export function openDocumentPreview(push, doc, guard = sharedGuard) {
  const target = previewTarget(doc);
  if (!target) return false;
  if (!guard.allow()) return false; // a double tap opens one preview, not two
  push(target);
  return true;
}
