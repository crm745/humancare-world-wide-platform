import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/Textarea';
import { REASON_MAX, REASON_MIN, validateReason } from '../documentActions.mjs';

// The two confirmations of the document review. The dialog owns only what is typed; the request,
// its busy state and its errors belong to useDocumentActions.
export function DocumentReviewDialogs({ dialog, busy, error, onConfirm, onCancel }) {
  if (!dialog) return null;
  return dialog.type === 'approve' ? (
    <ApproveDialog doc={dialog.doc} busy={busy} error={error} onConfirm={onConfirm} onCancel={onCancel} />
  ) : (
    // Keyed by document so a reason typed for one file is never carried over to another.
    <RejectDialog key={dialog.doc.id} doc={dialog.doc} busy={busy} error={error} onConfirm={onConfirm} onCancel={onCancel} />
  );
}

function ApproveDialog({ doc, busy, error, onConfirm, onCancel }) {
  return (
    <ConfirmDialog
      open
      title="Approve this document?"
      description={doc.originalName}
      confirmLabel="Approve document"
      busy={busy}
      error={error}
      onConfirm={() => onConfirm()}
      onCancel={onCancel}
    >
      <p className="text-sm text-slate-600">
        You are confirming that this document is clean and acceptable. It can still be rejected until the whole request is approved.
      </p>
    </ConfirmDialog>
  );
}

function RejectDialog({ doc, busy, error, onConfirm, onCancel }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const check = validateReason(reason);
  const wasApproved = doc.reviewStatus === 'approved';
  return (
    <ConfirmDialog
      open
      title="Reject this document?"
      description={doc.originalName}
      confirmLabel="Reject document"
      tone="danger"
      busy={busy}
      error={error}
      confirmDisabled={!check.ok}
      onConfirm={() => {
        setTouched(true);
        if (check.ok) onConfirm(check.value);
      }}
      onCancel={onCancel}
    >
      <p className="text-sm text-slate-600">
        The patient will be asked to upload a replacement, and the request moves to <span className="font-semibold">changes requested</span>.
        {wasApproved ? ' This document was approved earlier; rejecting it reverses that.' : ''}
      </p>
      <Textarea
        label="Reason (shown to the patient)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onBlur={() => setTouched(true)}
        maxLength={REASON_MAX}
        rows={4}
        disabled={busy}
        error={touched && !check.ok ? check.error : undefined}
        hint={`${REASON_MIN} to ${REASON_MAX} characters. Explain what is wrong so the patient can fix it.`}
      />
    </ConfirmDialog>
  );
}
