import { useState } from 'react';
import { Download, Eye, FileText, RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/Textarea';
import { DetailSection, Field, FieldList } from '../../requests/components/DetailSection';
import { formatDateTime } from '../../requests/format';
import { actionButtons, dialogCopy, formatAmount, formatSize, historyEntries, REASON_MAX, REASON_MIN, scanLabel, scanProminent, scanTone, splitVersions, statusLabel, statusTone, validateReason, validationMessage } from '../quotationView.mjs';
import { useQuotations } from '../useQuotations';

// Withdraw asks why (mandatory, kept on the version, never shown to the patient). Rendered only while open, so what was typed is gone when it closes.
function ActionDialog({ dialog, caseReference, busy, error, onConfirm, onCancel }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const { type, quotation: q } = dialog;
  const copy = dialogCopy(type, q, caseReference);
  const needsReason = type === 'withdraw';
  const check = needsReason ? validateReason(reason) : { ok: true };
  return (
    <ConfirmDialog
      open
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      tone={copy.tone}
      busy={busy}
      error={error}
      confirmDisabled={!check.ok}
      onConfirm={() => { setTouched(true); if (check.ok) onConfirm(check.value); }}
      onCancel={onCancel}
    >
      <Alert tone={type === 'withdraw' ? 'warning' : 'info'}>{copy.warning}</Alert>
      {needsReason && (
        <Textarea
          label="Reason (kept with the quotation, not shown to the patient)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => setTouched(true)}
          maxLength={REASON_MAX}
          rows={3}
          disabled={busy}
          error={touched && !check.ok ? check.error : undefined}
          hint={`${REASON_MIN} to ${REASON_MAX} characters.`}
        />
      )}
    </ConfirmDialog>
  );
}

function VersionHeader({ q, live }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-base font-semibold text-ink">Version {q.versionNumber}</h3>
      <Badge tone={statusTone(q.status)}>{statusLabel(q.status)}</Badge>
      <Badge tone={scanTone(q.scanStatus)} prominent={scanProminent(q.scanStatus)}>{scanLabel(q.scanStatus)}</Badge>
      {live && <Badge tone="info">Currently shown to the patient</Badge>}
    </div>
  );
}

function History({ q }) {
  const entries = historyEntries(q);
  if (!entries.length) return null;
  return (
    <ol className="mt-3 space-y-1.5 border-l border-slate-200 pl-4" aria-label={`History of version ${q.versionNumber}`}>
      {entries.map((e) => (
        <li key={e.key} className="text-xs text-slate-600">
          <span className="font-semibold text-slate-800">{e.label}</span>
          {e.by ? ` by ${e.by}` : ''} · <time dateTime={e.at}>{formatDateTime(e.at)}</time>
          {e.note ? <span className="block break-words text-slate-500">{e.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}

// The Case's quotation (Private Charter only): the version to act on, its PDF, amount, scan and the actions the server allows, then the history.
// Renders nothing for a Case that has no quotations feature (the server answers 404).
export default function QuotationSection({ caseId, caseReference }) {
  const qs = useQuotations(caseId);
  if (qs.notFound) return null;
  const { primary, others } = splitVersions(qs.data?.quotations);
  const live = qs.data?.livePublishedId ?? null;

  return (
    <DetailSection title="Quotation">
      <div className="space-y-4" aria-label="Quotation">
        {qs.notice && <Alert tone={qs.notice.tone}>{qs.notice.text}</Alert>}
        {qs.error && (
          <Alert tone="error">
            {qs.error}{' '}
            <button type="button" className="font-semibold underline" onClick={qs.reload}>Try again</button>
          </Alert>
        )}
        {qs.loading && !qs.data && <p className="text-sm text-slate-500">Loading the quotation…</p>}

        {qs.data && !primary && (
          <p className="text-sm text-slate-500">
            There is no quotation yet. It appears here when Operations upload the Quotation PDF, amount and currency on the Bitrix24 Deal.
          </p>
        )}

        {primary && (
          <div className="rounded-lg border border-slate-200 p-4" aria-label={`Quotation version ${primary.versionNumber}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <VersionHeader q={primary} live={primary.id === live} />
              <Button variant="ghost" size="sm" onClick={qs.reload} disabled={qs.loading} aria-label="Refresh quotation">
                <RefreshCw className={qs.loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              </Button>
            </div>

            <div className="mt-4">
              <FieldList>
                <Field label="Final amount" value={formatAmount(primary.amount, primary.currency)} />
                <Field label="Currency" value={primary.currency} />
                <Field label="PDF" value={`${formatSize(primary.sizeBytes)} · received ${formatDateTime(primary.createdAt)}`} />
                <Field label="Checksum (SHA-256)" value={primary.sha256 ? `${primary.sha256.slice(0, 16)}…` : null} optional />
                <Field label="Valid until" value={primary.validUntil ? formatDateTime(primary.validUntil) : null} optional />
              </FieldList>
            </div>

            {primary.validationError && <Alert tone="warning" className="mt-4">{validationMessage(primary.validationError)} Correct it in Bitrix24; this version updates by itself.</Alert>}
            {primary.scanStatus === 'infected' && <Alert tone="error" className="mt-4">The file was flagged by the malware scan. It cannot be opened or confirmed. Upload a clean PDF to the Bitrix24 Deal.</Alert>}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={!primary.actions.canViewFile || qs.fileBusyId != null} loading={qs.fileBusyId === primary.id} onClick={() => qs.openFile(primary, caseReference, 'view')}>
                {qs.fileBusyId !== primary.id && <Eye className="h-4 w-4" />}
                View PDF
              </Button>
              <Button variant="secondary" size="sm" disabled={!primary.actions.canViewFile || qs.fileBusyId != null} onClick={() => qs.openFile(primary, caseReference, 'download')}>
                <Download className="h-4 w-4" />
                Download PDF
              </Button>
              {actionButtons(primary).map((a) => (
                <Button key={a.key} variant={a.variant} size="sm" disabled={!a.enabled || qs.busy} onClick={() => qs.openDialog(a.key, primary)}>
                  {a.label}
                </Button>
              ))}
            </div>
            {actionButtons(primary).filter((a) => !a.enabled && a.why).map((a) => (
              <p key={a.key} className="mt-2 text-xs text-slate-500" role="note">{a.why}</p>
            ))}

            <History q={primary} />
          </div>
        )}

        {others.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-ink">Earlier versions</h3>
            <ul className="mt-2 space-y-3" aria-label="Quotation history">
              {others.map((q) => (
                <li key={q.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3" aria-label={`Quotation version ${q.versionNumber}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />
                      <span className="text-sm font-semibold text-ink">Version {q.versionNumber}</span>
                      <Badge tone={statusTone(q.status)}>{statusLabel(q.status)}</Badge>
                      <span className="text-xs text-slate-500">{formatAmount(q.amount, q.currency) || 'No amount'}</span>
                      {q.id === live && <Badge tone="info">Currently shown to the patient</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {actionButtons(q).map((a) => (
                        <Button key={a.key} variant={a.variant} size="sm" disabled={!a.enabled || qs.busy} onClick={() => qs.openDialog(a.key, q)}>{a.label}</Button>
                      ))}
                    </div>
                  </div>
                  <History q={q} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {qs.dialog && (
        <ActionDialog key={`${qs.dialog.type}-${qs.dialog.quotation.id}`} dialog={qs.dialog} caseReference={caseReference} busy={qs.busy} error={qs.dialogError} onConfirm={qs.submit} onCancel={qs.closeDialog} />
      )}
    </DetailSection>
  );
}
