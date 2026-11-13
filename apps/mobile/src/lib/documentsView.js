// What the My Documents screen shows, worked out from the fields the API already returns: file type, size, the
// "added to case" date, the search and the count. Pure (no React, no native modules), so it can be unit-tested.
import { formatDisplayDate } from './requestShape';

const TYPE_BY_EXTENSION = {
  pdf: { kind: 'pdf', label: 'PDF' },
  png: { kind: 'image', label: 'PNG' },
  jpg: { kind: 'image', label: 'JPG' },
  jpeg: { kind: 'image', label: 'JPG' },
  webp: { kind: 'image', label: 'WEBP' },
  doc: { kind: 'word', label: 'DOC' },
  docx: { kind: 'word', label: 'DOCX' },
};

// The extension of the file name: only a display hint (the name is whatever the patient called the file), never
// a check of what the file really is.
export function fileTypeOf(name) {
  const text = String(name == null ? '' : name).trim();
  const dot = text.lastIndexOf('.');
  const extension = dot > 0 && dot < text.length - 1 ? text.slice(dot + 1).toLowerCase() : '';
  return Object.hasOwn(TYPE_BY_EXTENSION, extension) ? TYPE_BY_EXTENSION[extension] : { kind: 'other', label: extension ? extension.slice(0, 5).toUpperCase() : '' };
}

// "42 KB", "1.4 MB"; nothing when the size is not known.
export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (bytes == null || !Number.isFinite(n) || n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// "PDF · 42 KB", or just one of them, or nothing.
export const fileMeta = (doc) => [fileTypeOf(doc && doc.name).label, formatFileSize(doc && doc.fileSizeBytes)].filter(Boolean).join(' · ');

// The date the API gives for a document ("03 Nov 2026"), shown on its own with no label. It is when the document was
// added to the case: the upload for a document from the original request form, but the Admin's approval for a
// Private Charter document in the review workflow, which is why it is not captioned "uploaded". Nothing is shown when
// the date is missing or not a real date (never today's date).
export function documentDate(uploadedAt) {
  if (!uploadedAt) return '';
  const time = new Date(uploadedAt).getTime();
  if (!Number.isFinite(time)) return '';
  return formatDisplayDate(uploadedAt);
}

// Search by file name or by the case reference (e.g. "CASE-1005"); case-insensitive, ignoring spaces at the ends.
// The list keeps the order the API gave it.
export function filterDocuments(docs, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return docs;
  return docs.filter((d) => String((d && d.name) || '').toLowerCase().includes(q)
    || String((d && d.case && d.case.referenceNumber) || '').toLowerCase().includes(q));
}

// "(6)" when everything is shown, "(2 of 6)" while a search narrows it.
export function countLabel(shown, total) {
  return shown === total ? `${total}` : `${shown} of ${total}`;
}

// ---- one download at a time per document -------------------------------------------------------------------------
// A guard that is checked and set in the same synchronous step, so two taps in the same moment (before React has drawn
// the "downloading" state) cannot both start. Another document is independent; after the task finishes (or fails) the
// same document can be tried again.
export function createDownloadGuard() {
  const active = new Set();
  return {
    isActive: (id) => active.has(id),
    // Resolves true when the task ran, false when this document was already being downloaded.
    async run(id, task) {
      if (active.has(id)) return false;
      active.add(id);
      try {
        await task();
        return true;
      } finally {
        active.delete(id);
      }
    },
  };
}

// ---- what a screen reader is told ---------------------------------------------------------------------------------
const percentOf = (state) => Math.round(((state && state.progress) || 0) * 100);

// The one label of a document card: what to do and which document, its type and size, the case reference, the date, and
// where its download stands (progress, or the error with how to try again). The visible parts of the card are hidden from
// the reader so nothing is said twice.
export function documentAccessibilityLabel(doc, state, t) {
  const status = state && state.status;
  const parts = [`${t('docs_download')} ${doc.name}`, fileMeta(doc), doc.case && doc.case.referenceNumber, documentDate(doc.uploadedAt)];
  if (status === 'downloading') {
    const percent = percentOf(state);
    parts.push(percent > 0 ? `${t('docs_downloading')} ${percent}%` : t('docs_downloading'));
  } else if (status === 'error' && state.message) {
    parts.push(state.message, t('docs_tap_retry'));
  }
  return parts.filter(Boolean).join('. ');
}

// What to announce when the download state changes, or '' for nothing: when it starts, when it fails (with how to try
// again) and when it finishes. Progress ticks are not announced; they are in the label for whoever focuses the card.
export function downloadAnnouncement(previous, next, doc, t) {
  const before = (previous && previous.status) || 'idle';
  const after = (next && next.status) || 'idle';
  if (after === 'downloading' && before !== 'downloading') return `${t('docs_downloading')} ${doc.name}`;
  if (after === 'error' && next.message && (before !== 'error' || (previous && previous.message) !== next.message)) return `${next.message}. ${t('docs_tap_retry')}`;
  if (before === 'downloading' && after === 'idle') return t('docs_downloaded').replace('{name}', doc.name);
  return '';
}
