import { forwardRef, useId } from 'react';
import { cn } from '@/utils/cn';

// `leftSlot` (an icon) and `variant="premium"` (taller, softer) are optional; without them the
// field looks and behaves exactly as before.
export const Input = forwardRef(function Input({ label, error, hint, className, id, rightSlot, leftSlot, variant = 'default', ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  const premium = variant === 'premium';
  return (
    <div className={className}>
      {label && (
        <label htmlFor={inputId} className={cn('mb-1.5 block text-sm font-medium', premium ? 'font-semibold text-ink' : 'text-slate-700')}>
          {label}
        </label>
      )}
      <div className="relative">
        {leftSlot && (
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400" aria-hidden="true">
            {leftSlot}
          </div>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error || hint ? messageId : undefined}
          className={cn(
            'w-full border bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-4',
            premium ? 'h-12 rounded-xl px-3.5 shadow-field' : 'h-11 rounded-lg px-3.5',
            leftSlot && 'pl-11',
            rightSlot && 'pr-11',
            error ? 'border-red-400 focus:ring-red-100' : cn('focus:border-brand-500 focus:ring-brand-100', premium ? 'border-slate-200' : 'border-slate-300'),
          )}
          {...rest}
        />
        {rightSlot && <div className="absolute inset-y-0 right-0 flex items-center pr-2">{rightSlot}</div>}
      </div>
      {error ? (
        <p id={messageId} className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
