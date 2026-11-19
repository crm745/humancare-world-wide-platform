import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/Textarea';
import { REASON_MAX, REASON_MIN, validateReason } from '../documentActions.mjs';

// Revoke a share: asks why. Rendered only while open, so what was typed is gone when it closes; keyed by share by the caller.
export function RevokeShareDialog({ doc, busy, error, onConfirm, onCancel }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const check = validateReason(reason, 'revoking this share');
  return (
    <ConfirmDialog
      open
      title="Revoke sharing of this document?"
      description={doc.originalName}
      confirmLabel="Revoke sharing"
      busy={busy}
      error={error}
      confirmDisabled={!check.ok}
      onConfirm={() => {
        setTouched(true);
        if (check.ok) onConfirm(check.value);
      }}
      onCancel={onCancel}
    >
      <Alert tone="warning">
        The attachment is removed from the Bitrix24 Deal. <span className="font-semibold">The original stays in HumanCare</span>, and you can authorize it again later.
      </Alert>
      <Textarea
        label="Reason (kept in the audit history)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onBlur={() => setTouched(true)}
        maxLength={REASON_MAX}
        rows={3}
        disabled={busy}
        error={touched && !check.ok ? check.error : undefined}
        hint={`${REASON_MIN} to ${REASON_MAX} characters.`}
      />
    </ConfirmDialog>
  );
}

// Open a document request on the Case: what is needed (the patient reads it) and, optionally, why.
export function DocumentRequestDialog({ referenceNumber, busy, error, onConfirm, onCancel }) {
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const check = validateReason(description, 'the documents you need');
  const why = reason.trim();
  const whyTooLong = why.length > REASON_MAX;
  return (
    <ConfirmDialog
      open
      title="Request documents from the patient"
      description={referenceNumber}
      confirmLabel="Send request"
      busy={busy}
      error={error}
      confirmDisabled={!check.ok || whyTooLong}
      onConfirm={() => {
        setTouched(true);
        if (check.ok && !whyTooLong) onConfirm({ description: check.value, reason: why || undefined });
      }}
      onCancel={onCancel}
    >
      <Alert tone="warning">
        <span className="font-semibold">The patient will see this.</span> Name the documents you need. They upload them in the app against this request, and you review each one here.
      </Alert>
      <Textarea
        label="Documents needed (visible to the patient)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => setTouched(true)}
        maxLength={REASON_MAX}
        rows={3}
        disabled={busy}
        error={touched && !check.ok ? check.error : undefined}
        hint={`${REASON_MIN} to ${REASON_MAX} characters, for example: "Passport copy of the patient and the travelling doctor."`}
      />
      <Textarea
        label="Why they are needed (optional, visible to the patient)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={REASON_MAX}
        rows={2}
        disabled={busy}
      />
    </ConfirmDialog>
  );
}
