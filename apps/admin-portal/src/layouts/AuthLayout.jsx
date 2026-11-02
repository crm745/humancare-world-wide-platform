import { HeartPulse, ShieldCheck } from 'lucide-react';
import logo from '@/assets/logo.png';

function BrandLockup({ onDark = false }) {
  return (
    <div className="flex items-center gap-4">
      <span className={onDark ? 'rounded-xl bg-white p-2 shadow-elevated' : ''}>
        <img src={logo} alt="HumanCare World Wide" className={onDark ? 'h-12 w-auto' : 'h-14 w-auto'} />
      </span>
      {onDark && (
        <>
          <span className="h-9 w-px bg-white/25" aria-hidden="true" />
          <span className="text-sm font-semibold uppercase tracking-[0.18em] text-brand-100">Admin Portal</span>
        </>
      )}
    </div>
  );
}

// Split-screen shell for the sign-in page: brand panel on large screens, form always.
export function AuthLayout({ children }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-brand-950 text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-600/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-brand-400/20 blur-3xl" />
        <div className="relative">
          <BrandLockup onDark />
        </div>
        <div className="relative max-w-md">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-white/10">
            <HeartPulse className="h-6 w-6" />
          </div>
          <h2 className="text-3xl font-bold leading-tight">Operations console for HumanCare World Wide</h2>
          <p className="mt-3 text-brand-100">Manage corporates, partner applications, cases, billing and support from one place.</p>
        </div>
        <div className="relative flex items-center gap-2 text-sm text-brand-200">
          <ShieldCheck className="h-4 w-4" />
          Authorised staff only. Sessions are protected and expire automatically.
        </div>
      </aside>

      <main className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center gap-2 text-center lg:hidden">
            <BrandLockup />
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Admin Portal</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
