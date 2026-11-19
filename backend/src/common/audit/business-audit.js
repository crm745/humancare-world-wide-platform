// Writer for the Private Charter business audit trail (the M3 `audit_logs` table): who did what, to which entity,
// from where and why. Deliberately separate from audit-log.js (security events) and from security_events.
//
// Append-only by construction: this module can only INSERT. Nothing in the application updates or deletes an
// audit row, and this file offers no way to.
//
// What may be stored: identifiers and a few state names only. `beforeData` / `afterData` accept ONLY the keys in
// ALLOWED_DATA_KEYS, with plain values (short text, number, boolean, null). Anything else is refused, so a
// name, phone number, email, medical text, document content, token or URL cannot be written by accident:
// the write throws, and when it runs inside a transaction the whole transaction rolls back. There is no free-text
// column here (no reasonText): a reason is a short code.
//
// Identifiers (entityId, idempotencyKey, correlationId, actorId) are opaque and stored exactly as given. They are
// never trimmed or changed, because the database compares them with a collation that ignores trailing spaces; a value
// with leading or trailing whitespace is refused instead.
const ALLOWED_DATA_KEYS = new Set([
  'caseId', 'caseReference', 'serviceRequestId', 'requestReference',
  'charterStage', 'previousCharterStage', 'stageVersion', 'status', 'previousStatus', 'reviewStatus', 'bitrixDealId',
  'bitrixStageId', 'inboxEventId', // inbound Deal-stage synchronization
  'eventId', 'newEventId', // integration_outbox ids (Deal failure alerts and manual recovery)
  'shareId', 'requestDocumentId', 'documentRequestId', 'bitrixFileId', // Bitrix Deal document sharing (identifiers only)
  'paymentId', 'invoiceId', 'razorpayOrderId', 'amount', 'currency', 'mode', // Razorpay order creation (identifiers, an exact decimal text, a code)
  // Razorpay webhook results (identifiers, exact decimal texts, an event name and yes/no flags; never a body, signature, error text or personal data)
  'razorpayPaymentId', 'razorpayRefundId', 'existingRazorpayPaymentId', 'eventType', 'expectedAmount', 'receivedAmount', 'receivedCurrency',
  // Quotation synchronization (identifiers, a version number, a state name and a short code; never a file name, URL or amount text)
  'quotationId', 'versionNumber', 'previousQuotationId', 'supersededById', 'scanStatus', 'validationError', 'sizeBytes',
  'lateCapture', 'duplicateCapture', 'overpayment', 'refundInconsistency', 'reconciliationRequired',
]);
const MAX_TEXT = 200;
const CODE = /^[a-z0-9_.:-]{1,64}$/;

function opaque(name, value, max, { required = false } = {}) {
  if (value == null) {
    if (required) throw new Error(`Audit entry: ${name} is required.`);
    return null;
  }
  const text = String(value);
  if (!text || text !== text.trim()) throw new Error(`Audit entry: ${name} must not be empty or have leading or trailing whitespace.`);
  if (text.length > max) throw new Error(`Audit entry: ${name} is longer than ${max} characters.`);
  return text;
}

function safeData(name, data) {
  if (data == null) return undefined;
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error(`Audit entry: ${name} must be an object.`);
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_DATA_KEYS.has(key)) throw new Error(`Audit entry: ${name} may not contain "${key}".`);
    if (value !== null && !['number', 'boolean'].includes(typeof value) && !(typeof value === 'string' && value.length <= MAX_TEXT)) {
      throw new Error(`Audit entry: ${name}.${key} must be a short text, number, boolean or null.`);
    }
    out[key] = value;
  }
  return out;
}

// `db` is the transaction (or client) the business change itself is written with.
function appendAuditLog(db, entry) {
  const reasonCode = entry.reasonCode == null ? null : String(entry.reasonCode);
  if (reasonCode !== null && !CODE.test(reasonCode)) throw new Error('Audit entry: reasonCode must be a short lowercase code.');
  const action = opaque('action', entry.action, 64, { required: true });
  const entityType = opaque('entityType', entry.entityType, 40, { required: true });
  return db.auditLog.create({
    data: {
      caseId: entry.caseId ?? null,
      entityType,
      entityId: opaque('entityId', entry.entityId, 64, { required: true }),
      action,
      actorType: opaque('actorType', entry.actorType, 16, { required: true }),
      actorId: opaque('actorId', entry.actorId, 64),
      actorRole: opaque('actorRole', entry.actorRole, 32),
      source: opaque('source', entry.source, 32, { required: true }),
      isOverride: entry.isOverride === true,
      reasonCode,
      beforeData: safeData('beforeData', entry.beforeData),
      afterData: safeData('afterData', entry.afterData),
      correlationId: opaque('correlationId', entry.correlationId, 64),
      idempotencyKey: opaque('idempotencyKey', entry.idempotencyKey, 191),
    },
  });
}

module.exports = { appendAuditLog, ALLOWED_DATA_KEYS };
