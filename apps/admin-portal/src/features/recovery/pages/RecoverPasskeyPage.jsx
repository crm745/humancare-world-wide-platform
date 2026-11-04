import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { AuthLayout } from '@/layouts/AuthLayout';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useLinkToken } from '@/hooks/useLinkToken';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { AuthHeading } from '@/features/auth/components/AuthHeading';
import { PasswordInput } from '@/features/auth/components/PasswordInput';
import { PasskeyRegistration } from '@/features/auth/components/PasskeyRegistration';
import { isWebAuthnSupported } from '@/services/webauthn';
import { redeemRecovery, recoveryRegistrationOptions, recoveryRegistrationVerify } from '../api';

// Recovering a lost passkey, on the target Admin's side. The steps:
//   1. the link's token is read from the URL fragment (and the fragment removed);
//   2. the CURRENT password is asked for and the link is redeemed - the backend answers with a
//      recovery ticket that lasts ten minutes;
//   3. the ticket is kept in this component's memory only, and exchanged for registration options;
//   4. the browser creates the new passkey and the backend verifies it.
// No session is created: the Admin signs in again afterwards. The token, the password and the
// ticket are never written to web storage or the console, and each is dropped as soon as it has
// done its job.
const TICKET_REJECTED = ['invalid_recovery'];

export default function RecoverPasskeyPage() {
  usePageTitle('Recover your passkey');
  const [token, forgetToken] = useLinkToken();
  const [phase, setPhase] = useState(token ? 'password' : 'no_link'); // password | register | done | expired | no_link
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // synchronous: state alone cannot stop a double Enter
  const [ticket, setTicket] = useState(null);
  const [ticketExpiresAt, setTicketExpiresAt] = useState(0);
  const supported = isWebAuthnSupported();

  // The ticket is only good for ten minutes; once that has passed it is dropped.
  useEffect(() => {
    if (phase !== 'register') return undefined;
    const timer = setTimeout(() => {
      setTicket(null);
      setPhase('expired');
    }, Math.max(0, ticketExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [phase, ticketExpiresAt]);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    if (!password) {
      setFieldError('Enter your current password.');
      return;
    }
    setFieldError('');
    if (inFlight.current) return; // synchronous guard against a double Enter/click
    inFlight.current = true;
    setBusy(true);
    try {
      const redeemed = await redeemRecovery(token, password);
      // Exchanged: the token and the password are no longer needed anywhere.
      forgetToken();
      setPassword('');
      setTicket(redeemed.ticket);
      setTicketExpiresAt(Date.now() + redeemed.ticketExpiresInSeconds * 1000);
      setPhase('register');
    } catch (err) {
      // The backend deliberately gives one answer for a wrong password and a bad link.
      setError(
        err.status === 400 && err.code === 'invalid_recovery'
          ? "That didn't work. Check your current password and try again. If it keeps failing, the link may have expired or been used up: ask your administrator for a new one."
          : err.message,
      );
      inFlight.current = false;
      setBusy(false);
    }
  }

  function ticketLost() {
    setTicket(null);
    setPhase('expired');
  }

  function done() {
    setTicket(null);
    setPhase('done');
  }

  if (phase === 'no_link') {
    return (
      <AuthLayout>
        <AuthHeading title="Recovery link not valid" />
        <Alert tone="warning">
          This page needs the link from your recovery email. Open the link exactly as it was sent. If it no longer works, ask your
          administrator for a new one.
        </Alert>
        <Link to="/login" className="mt-4 block text-center text-sm font-semibold text-brand-600 hover:underline">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (phase === 'expired') {
    return (
      <AuthLayout>
        <AuthHeading title="Recovery session ended" />
        <Alert tone="warning">
          Your recovery session is no longer valid. Nothing was changed on your account. Ask your administrator for a new recovery link,
          then open it to start again.
        </Alert>
        <Link to="/login" className="mt-4 block text-center text-sm font-semibold text-brand-600 hover:underline">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (phase === 'done') {
    return (
      <AuthLayout>
        <AuthHeading title="Passkey recovered" />
        <Alert tone="success">
          <p className="font-semibold">Your new passkey is ready.</p>
          <p className="mt-1">
            For your security, you have been signed out everywhere and your old passkey no longer works. Sign in again with your
            password and your new passkey.
          </p>
        </Alert>
        <Link
          to="/login"
          className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          Sign in
        </Link>
      </AuthLayout>
    );
  }

  if (phase === 'register') {
    return (
      <AuthLayout>
        <AuthHeading title="Create your new passkey">Your password was accepted.</AuthHeading>
        <PasskeyRegistration
          ticket={ticket}
          loadOptions={recoveryRegistrationOptions}
          verify={recoveryRegistrationVerify}
          onDone={done}
          onTicketInvalid={ticketLost}
          invalidCodes={TICKET_REJECTED}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title="Recover your passkey">Confirm it&apos;s you with your current password.</AuthHeading>
      {!supported && (
        <Alert tone="warning" className="mb-4">
          This browser can&apos;t use passkeys. Open the link in a current version of Chrome, Edge, Safari or Firefox.
        </Alert>
      )}
      {error && <Alert className="mb-4">{error}</Alert>}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <PasswordInput
          label="Current password"
          name="password"
          placeholder="Enter your current password"
          value={password}
          error={fieldError}
          disabled={busy}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldError) setFieldError('');
          }}
        />
        <Button type="submit" size="lg" loading={busy} disabled={!supported} className="w-full">
          Continue
        </Button>
      </form>
      <p className="mt-4 text-center text-xs text-slate-500">
        Your administrators have approved this recovery. You will be asked for a password, then to create a new passkey.
      </p>
    </AuthLayout>
  );
}
