import { useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ApiError } from '@/services/config';
import { createPasskey, isWebAuthnSupported } from '@/services/webauthn';

/**
 * The shared "create a passkey" step of first-time setup and of recovery: ask the server for the
 * options, let the browser create the credential (user verification stays required), send it back.
 *
 * `ticket` is held by the parent in memory only. `loadOptions(ticket)` and `verify(ticket,
 * response, label)` are the flow's own API calls. If the server says the ticket is no longer valid
 * (one of `invalidCodes`), `onTicketInvalid` is called and nothing more is shown here.
 */
export function PasskeyRegistration({ ticket, loadOptions, verify, onDone, onTicketInvalid, invalidCodes }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // synchronous: state alone cannot stop a double Enter
  const [error, setError] = useState('');
  // Checked before anything is asked of the server, so no challenge is issued for a browser that
  // could never answer it.
  const supported = isWebAuthnSupported();

  async function start() {
    if (inFlight.current) return;
    inFlight.current = true; // no duplicate submissions
    setBusy(true);
    setError('');
    try {
      const options = await loadOptions(ticket);
      const response = await createPasskey(options);
      await verify(ticket, response, label.trim());
      onDone();
    } catch (err) {
      if (err instanceof ApiError && invalidCodes.includes(err.code)) {
        onTicketInvalid();
        return;
      }
      setError(err.message);
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Now create your passkey. Your browser will ask you to use a security key, your fingerprint, face or screen lock. This is
        required every time you sign in.
      </p>
      {!supported && (
        <Alert tone="warning">This browser can&apos;t use passkeys. Open this page in a current version of Chrome, Edge, Safari or Firefox.</Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <Input
        label="Passkey name (optional)"
        name="passkey-label"
        maxLength={60}
        placeholder="For example: Work laptop"
        hint="Helps you tell your passkeys apart later."
        value={label}
        disabled={busy}
        onChange={(e) => setLabel(e.target.value)}
      />
      <Button size="lg" loading={busy} disabled={!supported} onClick={start} className="w-full">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        {busy ? 'Waiting for your passkey' : 'Create passkey'}
      </Button>
    </div>
  );
}
