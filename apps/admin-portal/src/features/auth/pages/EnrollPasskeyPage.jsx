import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '@/layouts/AuthLayout';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useLinkToken } from '@/hooks/useLinkToken';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { AuthHeading } from '../components/AuthHeading';
import { PasswordInput } from '../components/PasswordInput';
import { PasskeyRegistration } from '../components/PasskeyRegistration';
import { redeemEnrollment, enrollmentOptions, enrollmentVerify } from '../api';

// Finishing passkey setup from the "passkey" email (for an Admin who set a password but did not
// create a passkey). The link plus the CURRENT password buys a ten-minute enrollment ticket, kept
// in memory only. Nothing here creates a session: sign in afterwards.
const TICKET_REJECTED = ['invalid_enrollment'];

export default function EnrollPasskeyPage() {
  usePageTitle('Set up your passkey');
  const [token, forgetToken] = useLinkToken();
  const [phase, setPhase] = useState(token ? 'password' : 'blocked'); // password | register | done | expired | blocked
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // synchronous: state alone cannot stop a double Enter
  const [ticket, setTicket] = useState(null);

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
      const redeemed = await redeemEnrollment(token, password);
      forgetToken();
      setPassword('');
      setTicket(redeemed.ticket);
      setPhase('register');
    } catch (err) {
      // One answer for a wrong password and a bad link, by design.
      setError(
        err.status === 400 && err.code === 'invalid_invitation'
          ? "That didn't work. Check your password and try again. If it keeps failing, the link may have expired or been used up: ask your administrator for a new one."
          : err.message,
      );
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (phase === 'blocked') {
    return (
      <AuthLayout>
        <AuthHeading title="Setup link not valid" />
        <Alert tone="warning">
          This page needs the link from your passkey email. Open it exactly as it was sent, or ask your administrator for a new one.
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
        <AuthHeading title="Setup session ended" />
        <Alert tone="warning">Your setup session is no longer valid. Ask your administrator for a new link, then open it to start again.</Alert>
        <Link to="/login" className="mt-4 block text-center text-sm font-semibold text-brand-600 hover:underline">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (phase === 'done') {
    return (
      <AuthLayout>
        <AuthHeading title="You're all set" />
        <Alert tone="success">Your passkey is ready. Sign in with your email, your password and your passkey.</Alert>
        <Link
          to="/login"
          className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Sign in
        </Link>
      </AuthLayout>
    );
  }

  if (phase === 'register') {
    return (
      <AuthLayout>
        <AuthHeading title="Create your passkey">Your password was accepted.</AuthHeading>
        <PasskeyRegistration
          ticket={ticket}
          loadOptions={enrollmentOptions}
          verify={enrollmentVerify}
          onDone={() => {
            setTicket(null);
            setPhase('done');
          }}
          onTicketInvalid={() => {
            setTicket(null);
            setPhase('expired');
          }}
          invalidCodes={TICKET_REJECTED}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title="Set up your passkey">Confirm it&apos;s you with your password.</AuthHeading>
      {error && <Alert className="mb-4">{error}</Alert>}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <PasswordInput
          label="Password"
          name="password"
          placeholder="Enter your password"
          value={password}
          error={fieldError}
          disabled={busy}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldError) setFieldError('');
          }}
        />
        <Button type="submit" size="lg" loading={busy} className="w-full">
          Continue
        </Button>
      </form>
    </AuthLayout>
  );
}
