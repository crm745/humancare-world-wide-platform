import { Alert } from './Alert';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * "Are you sure?" for consequential actions (reject a document, approve a request).
 * The caller owns the request: it passes `busy` while it runs and `error` if it failed, and
 * closes the dialog on success. `children` is the place for a reason field or a summary.
 */
export function ConfirmDialog({ open, title, description, children, confirmLabel = 'Confirm', tone = 'primary', busy = false, error, confirmDisabled = false, onConfirm, onCancel }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
