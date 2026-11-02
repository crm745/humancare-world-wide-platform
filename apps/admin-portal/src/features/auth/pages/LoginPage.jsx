import { useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AuthLayout } from '@/layouts/AuthLayout';
import { useAuth } from '@/hooks/useAuth';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

// Basic shape check only; the server is the authority on whether the account exists.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(email, password) {
  const errors = {};
  if (!email) errors.email = 'Enter your email address.';
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address, like name@company.com.';
  if (!password) errors.password = 'Enter your password.';
  return errors;
}

export default function LoginPage() {
  usePageTitle('Sign in');
  const { login, sessionExpired, serverUnreachable, retry } = useAuth();
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    const trimmed = email.trim();
    const errors = validate(trimmed, password);
    setFieldErrors(errors);
    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();

    setSubmitting(true);
    try {
      // On success the route guard moves the user on (to the page they were heading to,
      // or the dashboard); this page just unmounts.
      await login(trimmed, password);
    } catch (err) {
      // 401 "Invalid credentials" and 429 "Too many login attempts" come straight from the API.
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Admin sign in</h1>
        <p className="mt-1 text-sm text-slate-500">Use your HumanCare admin account.</p>
      </div>

      {serverUnreachable && !error && (
        <Alert className="mb-4">
          <p>Unable to reach the server. Check your connection, then try again.</p>
          <button type="button" onClick={retry} className="mt-2 text-sm font-semibold underline">
            Try again
          </button>
        </Alert>
      )}
      {sessionExpired && !error && (
        <Alert tone="warning" className="mb-4">
          Your session expired. Please sign in again.
        </Alert>
      )}
      {error && <Alert className="mb-4">{error}</Alert>}

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Input
          ref={emailRef}
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          placeholder="you@humancareworldwide.com"
          value={email}
          error={fieldErrors.email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
          }}
        />
        <Input
          ref={passwordRef}
          label="Password"
          type={showPassword ? 'text' : 'password'}
          name="password"
          autoComplete="current-password"
          placeholder="Enter your password"
          value={password}
          error={fieldErrors.password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
          }}
          rightSlot={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="rounded-md p-1.5 text-slate-400 hover:text-slate-600"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          }
        />
        <Button type="submit" size="lg" loading={submitting} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
