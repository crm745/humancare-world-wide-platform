import { forwardRef, useId } from 'react';
import { cn } from '@/utils/cn';

// Same look and label/error/hint contract as <Input>. `maxLength` also shows a live counter.
export const Textarea = forwardRef(function Textarea({ label, error, hint, className, id, maxLength, value, rows = 4, ...rest }, ref) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const messageId = `${fieldId}-message`;
  return (
    <div className={className}>
      {label && (
        <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        value={value}
        maxLength={maxLength}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        className={cn(
          'w-full resize-y rounded-lg border bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-4',
          error ? 'border-red-400 focus:ring-red-100' : 'border-slate-300 focus:border-brand-500 focus:ring-brand-100',
        )}
        {...rest}
      />
      <div className="mt-1.5 flex items-start justify-between gap-3 text-xs">
        {error ? (
          <p id={messageId} className="text-red-600">{error}</p>
        ) : hint ? (
          <p id={messageId} className="text-slate-500">{hint}</p>
        ) : (
          <span />
        )}
        {maxLength && <span className="shrink-0 text-slate-400">{String(value ?? '').length}/{maxLength}</span>}
      </div>
    </div>
  );
});
