import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, KeyRound, RefreshCw, ShieldQuestion, XCircle } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Loading';
import { WebAuthnError, getPasskeyAssertion, isWebAuthnSupported } from '@/services/webauthn';
import { listRecoveryRequests, recoveryDecision, recoveryStepUp } from '../api';

// Deciding on an Admin's passkey-recovery request, as a superadmin. The backend decides who may do
// this (an active superadmin with a live session, who is not the Admin being recovered and has not
// decided yet) and re-checks everything on every call; this page only offers the steps.
//
// The list comes from GET /admin/recovery/requests: the open requests THIS superadmin can still
// decide on, each with the Admin being recovered and the reason, so the decision is made on what
// is in front of them. A reference number can still be typed in, as a fallback.
//
// Each decision is two calls with a passkey in between, separately for approving and rejecting:
//   1. ask for a step-up challenge for this request and this kind of decision;
//   2. answer it with the browser's passkey prompt (user verification is required);
//   3. send the assertion back with the decision.
// A challenge for an approval cannot be used for a rejection, and each lasts two minutes.

const KINDS = {
  approve: { verb: 'Approve', confirm: 'Approve with passkey' },
  reject: { verb: 'Reject', confirm: 'Reject with passkey' },
};

const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

// Fixed texts for the backend's coarse codes; the server's own text is the fallback.
function describeFailure(err) {
  if (err instanceof WebAuthnError) return { tone: 'error', text: err.message };
  switch (err.code) {
    case 'not_available':
      return {
        tone: 'error',
        text: "This request isn't available to you. It may not exist, may already be closed, or you may not be allowed to decide on it. You can never decide on your own recovery.",
      };
    case 'already_decided':
      return { tone: 'warning', text: 'You have already decided on this recovery request.' };
    case 'step_up_failed':
      return { tone: 'error', text: "Your passkey confirmation wasn't accepted. Nothing was recorded. Start the decision again." };
    case 'invalid_reason':
      return { tone: 'error', text: err.message };
    case 'invalid_request':
      return { tone: 'error', text: "The reference number or reason isn't valid." };
    case 'rate_limited':
      return { tone: 'warning', text: 'Too many attempts. Please wait a few minutes and try again.' };
    default:
      return { tone: 'error', text: err.status === 403 ? 'Only superadmins can decide on recovery requests.' : err.message };
  }
}

function describeSuccess(kind, result) {
  if (kind === 'reject') return 'The request was rejected. The Admin has been told it was not approved.';
  if (result.status === 'approved') return 'Your approval was the final one needed. The recovery link is being sent to the Admin by email.';
  return `Your approval is recorded (${result.validApprovals} of 2 needed). One more superadmin must approve before the Admin can recover.`;
}

function RequestSummary({ request }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Admin to recover</dt>
        <dd className="mt-0.5 break-words font-semibold text-slate-900">{request.target.name}</dd>
        <dd className="break-all text-slate-600">{request.target.email}</dd>
      </div>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Approvals</dt>
        <dd className="mt-0.5 text-slate-900">
          {request.approvalsReceived} of {request.approvalsRequired}
        </dd>
      </div>
      <div className="min-w-0 sm:col-span-2">
        <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reason given</dt>
        <dd className="mt-0.5 whitespace-pre-wrap break-words text-slate-900">{request.reason || 'No reason recorded.'}</dd>
      </div>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Requested</dt>
        <dd className="mt-0.5 text-slate-700">{formatDate(request.createdAt)}</dd>
      </div>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Expires</dt>
        <dd className="mt-0.5 text-slate-700">{formatDate(request.expiresAt)}</dd>
      </div>
    </dl>
  );
}

export default function RecoveryApprovalsPage() {
  const [requests, setRequests] = useState(null); // null = loading
  const [loadError, setLoadError] = useState('');
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const [selected, setSelected] = useState(null); // { id, ...the listed fields when picked from the list }
  const [kind, setKind] = useState(null); // approve | reject, once chosen
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // synchronous: state alone cannot stop a double click
  const [outcome, setOutcome] = useState(null); // { tone, text }
  const supported = isWebAuthnSupported(); // checked before a step-up is requested from the server

  const load = useCallback(async () => {
    setLoadError('');
    setRequests(null);
    try {
      setRequests(await listRecoveryRequests());
    } catch (err) {
      setRequests([]);
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function pick(request, chosenKind) {
    setOutcome(null);
    setReason('');
    setReasonError('');
    setSelected(request);
    setKind(chosenKind);
  }

  function openByReference(e) {
    e.preventDefault();
    setOutcome(null);
    if (!/^[1-9]\d{0,9}$/.test(reference.trim())) {
      setReferenceError('Enter the request reference number: digits only.');
      return;
    }
    setReferenceError('');
    setSelected({ id: Number(reference.trim()) });
    setKind(null);
  }

  function reset() {
    setSelected(null);
    setKind(null);
    setReason('');
    setReasonError('');
    setReference('');
  }

  async function confirm() {
    const cleanReason = reason.trim();
    if (kind === 'reject' && !cleanReason) {
      setReasonError('Give a reason for rejecting this request.');
      return;
    }
    if (inFlight.current) return; // synchronous guard against a double click
    inFlight.current = true;
    setReasonError('');
    setOutcome(null);
    setBusy(true);
    let finished = false;
    let staleList = false;
    try {
      const options = await recoveryStepUp(kind, selected.id);
      const assertion = await getPasskeyAssertion(options);
      const result = await recoveryDecision(kind, selected.id, assertion, cleanReason);
      setOutcome({ tone: 'success', text: describeSuccess(kind, result) });
      finished = true;
    } catch (err) {
      setOutcome(describeFailure(err));
      // The server says the request is gone, closed or already decided: what is listed is stale.
      if (err.code === 'not_available' || err.code === 'already_decided') staleList = true;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (finished) {
      reset();
      load(); // what is still waiting has changed
    } else if (staleList) {
      load(); // so the stale entry disappears from the list behind this panel
    }
  }

  const Kind = kind ? KINDS[kind] : null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Recovery approvals"
        subtitle="Approve or reject an Admin's request to replace a lost passkey. Two superadmins must approve, each with their own passkey."
      />

      {outcome && (
        <Alert tone={outcome.tone} className="mb-4">
          {outcome.text}
        </Alert>
      )}

      {selected ? (
        <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Decision">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recovery request</p>
              <p className="text-lg font-bold text-ink">Reference {selected.id}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              Change
            </Button>
          </div>

          {selected.target ? (
            <RequestSummary request={selected} />
          ) : (
            <Alert tone="warning">
              Opened by reference number, so the Admin and reason can&apos;t be shown. Check them with the operator before deciding.
            </Alert>
          )}

          {!supported && (
            <Alert tone="warning">This browser can&apos;t use passkeys, so you can&apos;t approve or reject here. Use a current version of Chrome, Edge, Safari or Firefox.</Alert>
          )}

          <p className="text-sm text-slate-600">
            Only decide if you have checked, outside this portal, that the Admin really asked to recover their passkey. You will be asked
            for your own passkey.
          </p>

          {!kind ? (
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button className="sm:flex-1" onClick={() => setKind('approve')}>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Approve
              </Button>
              <Button variant="danger" className="sm:flex-1" onClick={() => setKind('reject')}>
                <XCircle className="h-4 w-4" aria-hidden="true" />
                Reject
              </Button>
            </div>
          ) : (
            <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-900">
                {Kind.verb} request {selected.id}
                {selected.target ? ` for ${selected.target.name}` : ''}
              </p>
              <div>
                <label htmlFor="decision-reason" className="mb-1.5 block text-sm font-medium text-slate-700">
                  {kind === 'reject' ? 'Reason (required)' : 'Note (optional)'}
                </label>
                <textarea
                  id="decision-reason"
                  rows={3}
                  maxLength={500}
                  value={reason}
                  disabled={busy}
                  aria-invalid={reasonError ? 'true' : undefined}
                  onChange={(e) => {
                    setReason(e.target.value);
                    if (reasonError) setReasonError('');
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100"
                />
                {reasonError && <p className="mt-1.5 text-xs text-red-600">{reasonError}</p>}
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button variant={kind === 'reject' ? 'danger' : 'primary'} loading={busy} disabled={!supported} onClick={confirm} className="sm:flex-1">
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  {busy ? 'Waiting for your passkey' : Kind.confirm}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setKind(null)}>
                  Back
                </Button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <div className="space-y-6">
          <section aria-label="Requests waiting for you" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">Waiting for your decision</h2>
              <Button variant="ghost" size="sm" onClick={load} disabled={requests === null}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Refresh
              </Button>
            </div>

            {requests === null && (
              <div className="flex justify-center py-10 text-brand-600" role="status" aria-label="Loading requests">
                <Spinner className="h-6 w-6" />
              </div>
            )}
            {loadError && (
              <Alert>
                <p>{loadError}</p>
                <button type="button" onClick={load} className="mt-2 text-sm font-semibold underline">
                  Try again
                </button>
              </Alert>
            )}
            {requests && requests.length === 0 && !loadError && (
              <EmptyState
                icon={ShieldQuestion}
                title="No recovery requests are waiting for you"
                description="Requests you have already decided on, your own, and closed ones are not shown."
              />
            )}
            {requests?.map((request) => (
              <article key={request.id} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label={`Recovery request ${request.id}`}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reference {request.id}</p>
                <RequestSummary request={request} />
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Button className="sm:flex-1" onClick={() => pick(request, 'approve')}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    Review and approve
                  </Button>
                  <Button variant="danger" className="sm:flex-1" onClick={() => pick(request, 'reject')}>
                    <XCircle className="h-4 w-4" aria-hidden="true" />
                    Review and reject
                  </Button>
                </div>
              </article>
            ))}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Open by reference number">
            <form onSubmit={openByReference} noValidate className="space-y-4">
              <Input
                label="Request reference"
                name="reference"
                inputMode="numeric"
                autoComplete="off"
                placeholder="For example: 12"
                hint="Only needed if a request isn't listed above. Use the reference number from the operator."
                value={reference}
                error={referenceError}
                onChange={(e) => {
                  setReference(e.target.value);
                  if (referenceError) setReferenceError('');
                }}
              />
              <Button type="submit" className="w-full sm:w-auto">
                Continue
              </Button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
