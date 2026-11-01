import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

import { AuthLayout } from '@/layouts/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Misc';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useDocumentTitle } from '@/hooks/useUtils';

// Step 2 of corporate login: password (LoginPage) already sent an OTP to this email —
// this page exchanges that code for the real session. See authService.verifyOtp.
export default function VerifyOtpPage() {
  useDocumentTitle('Verify OTP');
  const { verifyOtp } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const { identifier, remember, from } = location.state ?? {};

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Arriving here directly (refresh, bookmark) with no identifier means there's no
  // pending login to complete — send them back to start one.
  useEffect(() => {
    if (!identifier) navigate('/login', { replace: true });
  }, [identifier, navigate]);

  if (!identifier) return null;

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const session = await verifyOtp(identifier, code.trim(), remember);
      toast.success('Welcome', session.user.companyName);
      // A temporary password has to be replaced before anything else is reachable.
      navigate(session.passwordChangeRequired ? '/change-password-required' : (from ?? '/dashboard'), { replace: true });
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Verification failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <Link to="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Back to login
      </Link>

      <div className="mt-8">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <ShieldCheck className="h-6 w-6" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">Enter verification code</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          We sent a 6-digit code to <span className="font-medium text-slate-700">{identifier}</span>.
        </p>
      </div>

      {error && (
        <Alert tone="error" className="mt-5">
          {error}
        </Alert>
      )}

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <Field label="Verification Code" htmlFor="otp-code">
          <Input
            id="otp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <Button type="submit" size="lg" fullWidth loading={submitting} disabled={code.length !== 6} className="!mt-6">
          {submitting ? 'Verifying…' : 'Verify & Sign In'}
        </Button>
      </form>
    </AuthLayout>
  );
}
