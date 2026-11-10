import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '@/layouts/AuthLayout';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useLinkToken } from '@/hooks/useLinkToken';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Loading';
import { AuthHeading } from '../components/AuthHeading';
import { PasswordInput } from '../components/PasswordInput';
import { PasskeyRegistration } from '../components/PasskeyRegistration';
import { acceptInvitation, enrollmentOptions, enrollmentVerify, inspectInvitation } from '../api';

// Accepting an Admin invitation (the first email): check the link, choose a password, then create
// a passkey. The link's token is read from the URL fragment and kept in memory only; the password
// and the enrollment ticket the server returns are dropped as soon as they have been used.
const TICKET_REJECTED = ['invalid_enrollment'];

// What the backend says about a link that cannot be used (it tells the holder used / revoked /
// expired, and nothing else).
const LINK_PROBLEMS = {
  used: 'This invitation has already been used. If you set a password but did not finish creating a passkey, use the link in your passkey email, or ask your administrator.',
  revoked: 'This invitation was cancelled. Ask your administrator for a new one.',
  expired: 'This invitation has expired. Ask your administrator for a new one.',
  invalid: 'This invitation link is not valid. Open it exactly as it was sent, or ask your administrator for a new one.',
};

const PASSWORD_HINT = 'At least 8 characters, with at least one letter and one number.';

// Mirrors the server's rule so most mistakes are caught before a request; the server decides.
function passwordProblem(password) {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (new TextEncoder().encode(password).length > 72) return 'Password must be at most 72 characters.';
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return 'Password must include at least one letter and one number.';
  return null;
}

export default function AcceptInvitePage() {
  usePageTitle('Accept your invitation');
  const [token, forgetToken] = useLinkToken();
  const [phase, setPhase] = useState(token ? 'checking' : 'blocked'); // checking | password | register | done | expired | blocked
  const [problem, setProblem] = useState(token ? '' : LINK_PROBLEMS.invalid);
  const [invite, setInvite] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // synchronous: state alone cannot stop a double Enter
  const [ticket, setTicket] = useState(null);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    inspectInvitation(token)
      .then((result) => {
        if (cancelled) return;
        if (result.valid && result.purpose === 'activation') {
          setInvite(result);
          setPhase('password');
        } else {
          setProblem(result.valid ? LINK_PROBLEMS.invalid : LINK_PROBLEMS[result.state] ?? LINK_PROBLEMS.invalid);
          setPhase('blocked');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setProblem(err.message);
        setPhase('blocked');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The enrollment ticket lasts ten minutes; once the server rejects it, it is dropped.
  function ticketLost() {
    setTicket(null);
    setPhase('expired');
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    const errors = {};
    const weak = passwordProblem(password);
    if (weak) errors.password = weak;
    if (!errors.password && confirm !== password) errors.confirm = 'The two passwords do not match.';
    setFieldErrors(errors);
    if (errors.password || errors.confirm) return;

    if (inFlight.current) return; // synchronous guard against a double Enter/click
    inFlight.current = true;
    setBusy(true);
    try {
      const accepted = await acceptInvitation(token, password);
      forgetToken();
      setPassword('');
      setConfirm('');
      setTicket(accepted.ticket);
      setPhase('register');
    } catch (err) {
      if (err.code === 'invalid_invitation') {
        setProblem(LINK_PROBLEMS.invalid);
        setPhase('blocked');
        return;
      }
      setError(err.message);
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (phase === 'checking') return <AuthLayout><PageLoader /></AuthLayout>;

  if (phase === 'blocked') {
    return (
      <AuthLayout>
        <AuthHeading title="Invitation not available" />
        <Alert tone="warning">{problem}</Alert>
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
        <Alert tone="warning">
          Your setup session is no longer valid. Your password was saved. Use the link in your passkey email, or ask your administrator
          to send you a new one, to finish creating your passkey.
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
        <AuthHeading title="You're all set" />
        <Alert tone="success">Your account is active. Sign in with your email, your password and your new passkey.</Alert>
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
        <AuthHeading title="Create your passkey">Your password is saved.</AuthHeading>
        <PasskeyRegistration
          ticket={ticket}
          loadOptions={enrollmentOptions}
          verify={enrollmentVerify}
          onDone={() => {
            setTicket(null);
            setPhase('done');
          }}
          onTicketInvalid={ticketLost}
          invalidCodes={TICKET_REJECTED}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title="Welcome to HumanCare Admin">
        {invite?.adminName ? `Hello ${invite.adminName}. ` : ''}Choose a password for {invite?.maskedEmail ?? 'your account'}.
      </AuthHeading>
      {error && <Alert className="mb-4">{error}</Alert>}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <PasswordInput
          label="New password"
          name="new-password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          value={password}
          error={fieldErrors.password}
          disabled={busy}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
          }}
        />
        <PasswordInput
          label="Confirm password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          error={fieldErrors.confirm}
          disabled={busy}
          onChange={(e) => {
            setConfirm(e.target.value);
            if (fieldErrors.confirm) setFieldErrors((f) => ({ ...f, confirm: undefined }));
          }}
        />
        <Button type="submit" size="lg" loading={busy} className="w-full">
          Save password and continue
        </Button>
      </form>
    </AuthLayout>
  );
}
