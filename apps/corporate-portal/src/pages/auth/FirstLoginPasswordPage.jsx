import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, LogOut } from 'lucide-react';
import { AuthLayout } from '@/layouts/AuthLayout';
import { Button } from '@/components/ui/Button';
import { Field, PasswordInput } from '@/components/ui/Input';
import { PasswordStrength } from '@/components/ui/PasswordStrength';
import { Alert } from '@/components/ui/Misc';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useDocumentTitle } from '@/hooks/useUtils';
import { changePasswordSchema } from '@/utils/schemas';

// The mandatory first-login step for an account whose password someone else chose (a
// provisioned Owner's temporary password). Until it succeeds the backend refuses every
// other call, so the portal keeps the person here (see PasswordChangeRoute / ProtectedRoute).
// Nothing typed here is kept: the values live only in the form and the one request.
export default function FirstLoginPasswordPage() {
  useDocumentTitle('Set a new password');
  const { user, completeFirstLogin, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { register, handleSubmit, watch, setError: setFieldError, formState } = useForm({
    resolver: zodResolver(changePasswordSchema),
    mode: 'onTouched',
    defaultValues: { currentPassword: '', password: '', confirmPassword: '' },
  });
  const { errors, isSubmitting } = formState;

  const onSubmit = handleSubmit(async ({ currentPassword, password }) => {
    setError('');
    try {
      await completeFirstLogin(currentPassword, password);
      toast.success('Password updated', 'Welcome to the HumanCare Corporate Portal.');
      navigate('/dashboard', { replace: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not change the password.';
      // A wrong temporary password belongs on that field; anything else is shown on top.
      if (msg.toLowerCase().includes('current password')) setFieldError('currentPassword', { message: msg });
      else setError(msg);
    }
  });

  const signOut = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <AuthLayout>
      <div className="mt-2">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <KeyRound className="h-6 w-6" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">Set a new password</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          {user?.email ? <><span className="font-medium text-slate-700">{user.email}</span> is signed in with a temporary password. </> : 'You signed in with a temporary password. '}
          For security, choose your own password before continuing.
        </p>
      </div>

      {error && (
        <Alert tone="error" className="mt-5">
          {error}
        </Alert>
      )}

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <Field label="Temporary Password" required error={errors.currentPassword?.message} htmlFor="fl-current">
          <PasswordInput id="fl-current" autoComplete="current-password" invalid={!!errors.currentPassword} {...register('currentPassword')} />
        </Field>
        <Field label="New Password" required error={errors.password?.message} htmlFor="fl-new">
          <PasswordInput id="fl-new" autoComplete="new-password" invalid={!!errors.password} {...register('password')} />
        </Field>
        <PasswordStrength password={watch('password')} />
        <Field label="Confirm New Password" required error={errors.confirmPassword?.message} htmlFor="fl-confirm">
          <PasswordInput id="fl-confirm" autoComplete="new-password" invalid={!!errors.confirmPassword} {...register('confirmPassword')} />
        </Field>
        <Button type="submit" size="lg" fullWidth loading={isSubmitting} className="!mt-6">
          Update Password &amp; Continue
        </Button>
      </form>

      <button
        type="button"
        onClick={signOut}
        disabled={isSubmitting}
        className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800 disabled:opacity-50"
      >
        <LogOut className="h-4 w-4" /> Sign out
      </button>
    </AuthLayout>
  );
}
