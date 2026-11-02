import { AlertCircle, Info } from 'lucide-react';
import { cn } from '@/utils/cn';

const TONES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
};

export function Alert({ tone = 'error', children, className }) {
  const Icon = tone === 'error' ? AlertCircle : Info;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm', TONES[tone], className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
