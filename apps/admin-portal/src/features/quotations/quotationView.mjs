// Pure view rules for the Case's quotation section: labels, tones, which version is shown first, which actions are offered and why one is not,
// the history, the dialogs' wording and how a failed call is explained. No React and no network, so node:test covers it
// (quotationView.test.mjs). The SERVER decides what is allowed (`quotation.actions`); nothing here decides it, this only presents it.

const STATUS = {
  draft: { label: 'Draft', tone: 'neutral' },
  confirmed: { label: 'Confirmed, not published', tone: 'info' },
  published: { label: 'Published', tone: 'success' },
  accepted: { label: 'Accepted by the patient', tone: 'success' },
  rejected: { label: 'Rejected by the patient', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};
export const statusLabel = (status) => (STATUS[status] ? STATUS[status].label : 'Unknown');
export const statusTone = (status) => (STATUS[status] ? STATUS[status].tone : 'neutral');

const SCAN = {
  pending: { label: 'Malware scan pending', tone: 'warning' },
  clean: { label: 'Malware scan clean', tone: 'success' },
  error: { label: 'Malware scan not completed', tone: 'warning' },
  infected: { label: 'Malware detected', tone: 'danger', prominent: true },
};
export const scanLabel = (scan) => (SCAN[scan] ? SCAN[scan].label : 'Scan state unknown');
export const scanTone = (scan) => (SCAN[scan] ? SCAN[scan].tone : 'neutral');
export const scanProminent = (scan) => Boolean(SCAN[scan] && SCAN[scan].prominent);

const VALIDATION = {
  amount_missing: 'The Final Quotation Amount is empty in Bitrix24.',
  currency_missing: 'The Final Quotation Currency is empty in Bitrix24.',
  amount_invalid: 'The amount in Bitrix24 is not a valid number.',
  amount_not_positive: 'The amount in Bitrix24 must be greater than zero.',
  amount_precision: 'The amount in Bitrix24 has more decimals than its currency allows.',
  currency_invalid: 'The currency in Bitrix24 is not a three-letter currency code such as INR.',
  currency_unsupported: 'The currency in Bitrix24 is not supported.',
};
export const validationMessage = (code) => (code ? VALIDATION[code] || 'The amount or currency in Bitrix24 is not valid.' : null);

/** "₹1,000.00" for 1000.000 INR; the raw "1000.000 INR" if the currency is unknown to the browser. Display only: nothing is calculated. */
export function formatAmount(amount, currency) {
  if (amount === null || amount === undefined || amount === '' || !currency) return null;
  const number = Number(amount);
  if (!Number.isFinite(number)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(number);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const WORKING = new Set(['draft', 'confirmed']);
const LIVE = new Set(['published', 'accepted']);

/** { primary, others }: the version to act on first (the unpublished working one, else the live one, else the newest) and the rest, newest first. */
export function splitVersions(quotations) {
  const list = Array.isArray(quotations) ? [...quotations].sort((a, b) => b.versionNumber - a.versionNumber) : [];
  const primary = list.find((q) => WORKING.has(q.status)) || list.find((q) => q.live && LIVE.has(q.status)) || list[0] || null;
  return { primary, others: list.filter((q) => q !== primary) };
}

const who = (admin) => (admin ? admin.name || `Admin #${admin.id}` : null);

/** The timeline of one version, oldest first: what happened, when and by whom. Only what the server returned; nothing is invented. */
export function historyEntries(q) {
  const out = [];
  const add = (key, label, at, by, note) => { if (at) out.push({ key, label, at, by: by || null, note: note || null }); };
  add('received', 'Received from Bitrix24', q.createdAt);
  add('scan', q.scanStatus === 'clean' ? 'Malware scan clean' : q.scanStatus === 'infected' ? 'Malware detected' : null, q.scannedAt);
  add('confirmed', 'Confirmed', q.confirmedAt, who(q.confirmedBy));
  add('published', 'Published to the patient', q.publishedAt, who(q.publishedBy), q.validUntil ? `Valid until ${q.validUntil}` : null);
  add('decided', q.status === 'rejected' ? 'Rejected by the patient' : q.status === 'accepted' ? 'Accepted by the patient' : null, q.decidedAt, null, q.rejectionReason);
  add('superseded', 'Replaced by a newer version', q.supersededAt);
  add('withdrawn', 'Withdrawn', q.withdrawnAt, who(q.withdrawnBy), q.withdrawReason);
  return out.sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * The buttons to show for one version. `enabled` comes from the server; a disabled button carries the reason (`why`) so the Admin is told what to fix.
 * Confirm / Publish appear only for the state they act on; Withdraw whenever the server allows it; "Create new version" only for a version it allows.
 */
export function actionButtons(q) {
  const a = q.actions || {};
  const blockers = Array.isArray(a.blockers) ? a.blockers : [];
  const why = blockers.length ? blockers.map((b) => b.message).join(' ') : null;
  const out = [];
  if (q.status === 'draft') out.push({ key: 'confirm', label: 'Confirm amount and currency', variant: 'primary', enabled: Boolean(a.canConfirm), why: a.canConfirm ? null : why });
  if (q.status === 'confirmed') out.push({ key: 'publish', label: 'Publish to patient', variant: 'primary', enabled: Boolean(a.canPublish), why: a.canPublish ? null : why });
  if (a.canCreateVersion) out.push({ key: 'newVersion', label: 'Create new version', variant: 'secondary', enabled: true, why: null });
  if (a.canWithdraw) out.push({ key: 'withdraw', label: 'Withdraw', variant: 'danger', enabled: true, why: null });
  return out;
}

export const REASON_MIN = 3;
export const REASON_MAX = 1000;
export function validateReason(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length < REASON_MIN) return { ok: false, error: `Enter at least ${REASON_MIN} characters.` };
  if (value.length > REASON_MAX) return { ok: false, error: `Use at most ${REASON_MAX} characters.` };
  return { ok: true, value };
}

/** What each dialog says. Always names the version, the amount and what the action causes. */
export function dialogCopy(type, q, caseReference) {
  const money = formatAmount(q.amount, q.currency) || 'no amount';
  const name = `${caseReference ? `${caseReference} · ` : ''}Version ${q.versionNumber}`;
  switch (type) {
    case 'confirm':
      return { title: 'Confirm this amount and currency?', description: name, confirmLabel: 'Confirm', tone: 'primary',
        warning: `You are confirming ${money} as the final quotation. The patient does not see it yet: publishing is a separate step.` };
    case 'publish':
      return { title: 'Publish this quotation to the patient?', description: name, confirmLabel: 'Publish', tone: 'primary',
        warning: `${money} will become visible to the patient in the app, and they will be notified. Any quotation published before it is replaced. If it changes later, a new version is needed.` };
    case 'withdraw':
      return { title: 'Withdraw this quotation?', description: name, confirmLabel: 'Withdraw', tone: 'danger',
        warning: q.status === 'published' ? 'The patient will no longer see this quotation. It stays in the history.' : 'This version is closed and stays in the history.' };
    case 'newVersion':
      return { title: 'Create a new version of this quotation?', description: name, confirmLabel: 'Create new version', tone: 'primary',
        warning: 'A new draft with the same PDF, amount and currency is created. It is scanned again, then must be confirmed and published, and the patient must accept it again. The current version is not changed.' };
    default:
      return { title: 'Are you sure?', description: name, confirmLabel: 'Confirm', tone: 'primary', warning: '' };
  }
}

export const successText = (type, result, q) => {
  const v = `Version ${q.versionNumber}`;
  switch (type) {
    case 'confirm': return result.alreadyConfirmed ? `${v} was already confirmed.` : `${v} is confirmed. Publish it when you are ready for the patient to see it.`;
    case 'publish': return result.alreadyPublished ? `${v} was already published.` : `${v} is published. The patient has been notified.`;
    case 'withdraw': return result.alreadyWithdrawn ? `${v} was already withdrawn.` : `${v} was withdrawn.`;
    case 'newVersion': return `A new draft version was created from ${v}. It will be scanned, then it can be confirmed.`;
    default: return 'Done.';
  }
};

/** How a failed call reads. 404 / 409 mean the version is no longer what the page showed: the page refreshes. A 401 is handled globally. */
export function errorNotice(err, what = 'The action') {
  const code = err && err.code;
  const message = (err && err.message) || `${what} could not be completed.`;
  if (code === 'quotation_changed') return { tone: 'warning', text: 'The quotation changed since you opened it (a new file or amount may have arrived from Bitrix24). It has been reloaded; please check it again.', refresh: true };
  if (err && (err.status === 409 || err.status === 404)) return { tone: 'warning', text: `${message} The page has been refreshed with the current state.`, refresh: true };
  return { tone: 'error', text: `${what} could not be completed. ${message}`, refresh: false };
}
