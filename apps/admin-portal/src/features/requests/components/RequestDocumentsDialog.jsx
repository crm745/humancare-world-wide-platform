import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/Textarea';
import { REASON_MAX, REASON_MIN, validateReason } from '../documentActions.mjs';

const PURPOSE = 'requesting additional documents';

/**
 * Asks the patient for more documents. Rendered only while it is open, so what was typed is gone
 * when it closes. The request itself, its busy state and its errors belong to useDocumentActions.
 */
export function RequestDocumentsDialog({ referenceNumber, busy, error, onConfirm, onCancel }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const check = validateReason(reason, PURPOSE);
  return (
    <ConfirmDialog
      open
      title="Request additional documents"
      description={referenceNumber}
      confirmLabel="Send request"
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
        <span className="font-semibold">The patient will see this reason.</span> Write it for the patient, and name the documents you need. They can then upload
        them against this same request; their earlier documents stay in the history.
      </Alert>
      <Textarea
        label="Reason (visible to the patient)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onBlur={() => setTouched(true)}
        maxLength={REASON_MAX}
        rows={4}
        disabled={busy}
        error={touched && !check.ok ? check.error : undefined}
        hint={`${REASON_MIN} to ${REASON_MAX} characters, for example: "Please upload a fitness-to-fly certificate issued in the last 7 days."`}
      />
      <p className="text-xs text-slate-500">The request cannot be approved until the patient has answered and every new document is scanned and reviewed.</p>
    </ConfirmDialog>
  );
}
