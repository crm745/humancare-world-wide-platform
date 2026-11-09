import { ShieldAlert } from 'lucide-react';
import { cn } from '@/utils/cn';

const TONES = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-brand-50 text-brand-700 ring-brand-200',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-900 ring-amber-200',
  danger: 'bg-red-50 text-red-800 ring-red-200',
};

/**
 * Small status pill. `prominent` is for states that must not be missed (an infected
 * document): solid red, with an icon, so it does not rely on colour alone.
 */
export function Badge({ tone = 'neutral', prominent = false, className, children }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        prominent ? 'bg-red-600 text-white ring-red-700' : TONES[tone],
        className,
      )}
    >
      {prominent && <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />}
      {children}
    </span>
  );
}
