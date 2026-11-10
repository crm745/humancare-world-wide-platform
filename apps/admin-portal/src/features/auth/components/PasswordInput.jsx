import { forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/Input';

/** The portal's Input with a show/hide button, for the pages that ask for a password. */
export const PasswordInput = forwardRef(function PasswordInput({ label = 'Password', autoComplete = 'current-password', ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      ref={ref}
      label={label}
      type={shown ? 'text' : 'password'}
      autoComplete={autoComplete}
      rightSlot={
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          className="rounded-md p-1.5 text-slate-400 hover:text-slate-600"
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      }
      {...rest}
    />
  );
});
