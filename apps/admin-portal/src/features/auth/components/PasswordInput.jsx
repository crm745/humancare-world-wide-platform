import { forwardRef, useState } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { Input } from '@/components/ui/Input';

/** The portal's Input with a lock icon and a show/hide button, for the pages that ask for a password. */
export const PasswordInput = forwardRef(function PasswordInput({ label = 'Password', autoComplete = 'current-password', ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      ref={ref}
      label={label}
      variant="premium"
      type={shown ? 'text' : 'password'}
      autoComplete={autoComplete}
      leftSlot={<Lock className="h-[18px] w-[18px]" />}
      rightSlot={
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          className="rounded-md p-1.5 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {shown ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
        </button>
      }
      {...rest}
    />
  );
});
