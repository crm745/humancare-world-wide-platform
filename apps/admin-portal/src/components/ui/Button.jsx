import { cn } from '@/utils/cn';
import { Spinner } from './Loading';

const VARIANTS = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-300',
  secondary: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-200',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-200',
  ghost: 'text-slate-600 hover:bg-slate-100 focus-visible:ring-slate-200',
  // HumanCare red call to action (sign-in screens).
  accent: 'bg-gradient-to-b from-accent-500 to-accent-700 text-white shadow-accent hover:from-accent-600 hover:to-accent-800 focus-visible:ring-accent-200',
};
const SIZES = { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', lg: 'h-11 px-5 text-sm', xl: 'h-12 rounded-xl px-6 text-base' };

export function Button({ variant = 'primary', size = 'md', loading = false, disabled, className, children, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors focus:outline-none focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}
