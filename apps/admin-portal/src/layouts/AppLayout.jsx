import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LogOut, Menu, ShieldCheck, UserRound, X } from 'lucide-react';
import logoMark from '@/assets/logo-mark.png';
import { cn } from '@/utils/cn';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';
import { PageLoader } from '@/components/ui/Loading';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NAV_ITEMS, canAccess } from '@/routes/navItems';

function NavList({ items, onNavigate }) {
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
      <ul className="space-y-0.5">
        {items.map(({ label, path, icon: Icon }) => (
          <li key={path}>
            <NavLink
              to={path}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )
              }
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="truncate">{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// One full-width bar, so its bottom border spans the whole panel; the close button (drawer
// only) sits at the right end of the same row.
function BrandBar({ onClose }) {
  return (
    <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-5">
      <div className="flex items-center gap-2.5">
        <img src={logoMark} alt="" className="h-8 w-8" />
        <div className="leading-tight">
          <p className="text-sm font-bold text-ink">HumanCare</p>
          <p className="text-[11px] font-medium text-slate-500">Admin Portal</p>
        </div>
      </div>
      {onClose && (
        <button type="button" onClick={onClose} className="-mr-2 rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-200" aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}

function initialsOf(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

// /admin/me carries no name, so after a reload only the role is known. Show that
// honestly (role as the headline) instead of a placeholder like "Signed in".
function AccountBadge({ admin, isSuperadmin }) {
  const roleLabel = isSuperadmin ? 'Superadmin' : 'Admin';
  const name = admin?.name || null;
  const secondary = name ? roleLabel : admin?.corporateReview && !isSuperadmin ? 'Corporate review' : null;
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700" aria-hidden="true">
        {name ? initialsOf(name) : isSuperadmin ? <ShieldCheck className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}
      </div>
      <div className="hidden text-left leading-tight sm:block">
        <p className="max-w-[12rem] truncate text-sm font-semibold text-slate-900">{name ?? roleLabel}</p>
        {secondary && <p className="text-xs text-slate-500">{secondary}</p>}
      </div>
    </div>
  );
}

export function AppLayout() {
  const auth = useAuth();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer on navigation, and if the window grows to desktop width.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const onChange = (e) => e.matches && setDrawerOpen(false);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const items = NAV_ITEMS.filter((item) => canAccess(item.access, auth));

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <BrandBar />
        <NavList items={items} />
      </aside>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} label="Navigation">
        <BrandBar onClose={() => setDrawerOpen(false)} />
        <NavList items={items} onNavigate={() => setDrawerOpen(false)} />
      </Drawer>

      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
        <button type="button" onClick={() => setDrawerOpen(true)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-200 lg:hidden" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <div className="hidden lg:block" />
        <div className="flex items-center gap-3">
          <AccountBadge admin={auth.admin} isSuperadmin={auth.isSuperadmin} />
          <Button variant="secondary" size="sm" onClick={auth.logout} disabled={auth.loggingOut}>
            <LogOut className="h-4 w-4" />
            Log out
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        {auth.logoutError && <Alert className="mb-6">{auth.logoutError}</Alert>}
        {/* A crash or failed page load stays inside the content area; the shell keeps working. */}
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
