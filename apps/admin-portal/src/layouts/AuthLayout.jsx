import { BriefcaseMedical, Building2, Lock, ReceiptText } from 'lucide-react';
import logo from '@/assets/logo.png';
import { LOGIN_HERO_IMAGE_URL } from '@/features/auth/heroImage';

// Presentation only. Two shells for the sign-in family of pages:
//   variant="split"   the full sign-in screen: hero panel (large screens) + form.
//   variant="compact" (default) a centred card for the secondary pages (accept invitation, passkey
//                     enrollment, passkey recovery): same branding, no hero.

// How far the hero panel's right edge leans, in px (top edge is further right than the bottom).
const SLANT = 72;
const EDGE_SHAPE = `polygon(0 0, 100% 0, calc(100% - ${SLANT}px) 100%, 0 100%)`;
// The blue/purple sliver that sits against the red edge at the bottom of the panel.
// 14% of the panel height, so the edge shifts SLANT * 0.14 px along it; the third point is how far it reaches inward.
const WEDGE_SHAPE = `polygon(${200 - SLANT * 0.86}px 0, ${200 - SLANT}px 100%, ${200 - SLANT - 80}px 100%)`;

const FEATURES = [
  { icon: BriefcaseMedical, title: 'Case & Assistance Management', text: 'Track medical cases, approvals and escalations with complete visibility.' },
  { icon: Building2, title: 'Corporate & Partner Network', text: 'Manage corporates, providers and partner applications efficiently.' },
  { icon: ReceiptText, title: 'Billing & Reporting', text: 'Invoices, claims and operational reports in one place.' },
];

function SecureNote({ className = '' }) {
  return (
    <p className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${className}`}>
      <span className="flex items-center gap-2">
        <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
        Secure Enterprise Access
      </span>
      <span className="hidden h-4 w-px bg-current opacity-40 sm:block" aria-hidden="true" />
      <span>Authorized Personnel Only</span>
    </p>
  );
}

function AdminPortalLabel() {
  return (
    <div className="flex items-center gap-5">
      <span className="h-12 w-px bg-white/50" aria-hidden="true" />
      <span className="text-sm font-semibold uppercase tracking-[0.22em] text-white">Admin Portal</span>
    </div>
  );
}

function HeroPanel() {
  return (
    <aside className="relative z-10 hidden lg:block">
      {/* Red edge: the same shape as the photo, a few pixels wider, sitting behind it. */}
      <div className="absolute inset-y-0 left-0 -right-1 bg-accent-600" style={{ clipPath: EDGE_SHAPE }} aria-hidden="true" />
      {/* Photo + navy overlay. The background image is not requested on screens below `lg`. */}
      <div className="absolute inset-0 bg-navy-950" style={{ clipPath: EDGE_SHAPE }} aria-hidden="true">
        <div className="absolute inset-0 bg-cover bg-[position:70%_center]" style={{ backgroundImage: `url("${LOGIN_HERO_IMAGE_URL}")` }} />
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgba(7,20,51,.97) 0%, rgba(10,31,77,.85) 55%, rgba(10,31,77,.4) 100%), linear-gradient(0deg, rgba(7,20,51,.85) 0%, rgba(7,20,51,0) 40%)',
          }}
        />
      </div>
      {/* Blue to purple accent at the foot of the edge. */}
      <div
        className="absolute bottom-0 right-0 h-[14%] w-[200px] bg-gradient-to-b from-brand-600 to-violet-700"
        style={{ clipPath: WEDGE_SHAPE }}
        aria-hidden="true"
      />

      <div className="relative flex h-full min-h-screen flex-col justify-between py-12 pl-12 pr-28 xl:pl-16 xl:pr-32">
        <AdminPortalLabel />

        <div className="max-w-xl py-10">
          <h2 className="text-4xl font-bold leading-[1.1] tracking-tight text-white xl:text-5xl 2xl:text-6xl">
            Global Healthcare
            <span className="block text-accent-400">Operations</span>
          </h2>
          <p className="mt-6 max-w-lg text-base leading-relaxed text-white/85 xl:text-lg">
            A unified platform to manage patients, corporate operations, medical assistance and end-to-end healthcare services across locations.
          </p>
          <ul className="mt-9 space-y-4">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex items-start gap-4">
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-white/10 text-white backdrop-blur-sm">
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-base font-semibold text-white">{title}</span>
                  <span className="mt-0.5 block max-w-sm text-sm leading-snug text-white/70">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-white/15 pt-5">
          <SecureNote className="text-white/85" />
        </div>
      </div>
    </aside>
  );
}

function Logo({ className = 'h-16' }) {
  return <img src={logo} alt="HumanCare World Wide" className={`mx-auto w-auto ${className}`} />;
}

export function AuthLayout({ children, variant = 'compact' }) {
  if (variant === 'split') {
    return (
      <div className="min-h-screen lg:grid lg:grid-cols-[57fr_43fr]">
        <HeroPanel />

        <div className="flex min-h-screen flex-col bg-gradient-to-br from-white via-slate-50 to-slate-100 lg:min-h-0">
          {/* Below `lg` there is no hero, so a slim navy bar keeps the brand identity. */}
          <div className="border-b-[3px] border-accent-600 bg-navy-950 px-5 py-3 lg:hidden">
            <AdminPortalLabel />
          </div>
          <main className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 lg:pl-4 xl:px-12">
            <div className="w-full max-w-[30rem]">
              <div className="mb-6">
                <Logo className="h-14 sm:h-16 lg:h-[4.5rem]" />
              </div>
              {children}
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-navy-950 via-brand-950 to-brand-900">
      <header className="px-5 pt-8 text-center sm:pt-10">
        <span className="text-xs font-semibold uppercase tracking-[0.22em] text-white/80">HumanCare Admin Portal</span>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-elevated">
          <div className="h-1 bg-gradient-to-r from-accent-600 via-accent-500 to-brand-600" aria-hidden="true" />
          <div className="px-5 py-8 sm:px-8">
            <div className="mb-6">
              <Logo className="h-14" />
            </div>
            {children}
          </div>
        </div>
      </main>
      <footer className="px-5 pb-8 text-center">
        <SecureNote className="justify-center text-white/70" />
      </footer>
    </div>
  );
}
