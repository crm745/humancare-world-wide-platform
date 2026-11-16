import { ChevronRight, LogOut, Menu, ShieldCheck, UserRound } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { NAV_ITEMS } from '@/routes/navItems';
import { Button } from '@/components/ui/Button';

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
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-navy-900 text-xs font-bold text-white" aria-hidden="true">
        {name ? initialsOf(name) : isSuperadmin ? <ShieldCheck className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}
      </div>
      <div className="hidden text-left leading-tight sm:block">
        <p className="max-w-[12rem] truncate text-sm font-semibold text-slate-900">{name ?? roleLabel}</p>
        {secondary && <p className="text-xs text-slate-500">{secondary}</p>}
      </div>
    </div>
  );
}

// "Operations > Dashboard": the section and item that own the current URL (the longest matching path, so a
// request's details page reads as its list). Plain text, not a heading or links, so it adds nothing to the page outline.
function Location() {
  const { pathname } = useLocation();
  const match = NAV_ITEMS.filter((i) => pathname === i.path || pathname.startsWith(`${i.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return (
    <p className="hidden items-center gap-1.5 text-sm text-slate-500 sm:flex">
      {match ? (
        <>
          <span>{match.group}</span>
          <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
          <span className="font-semibold text-slate-800">{match.label}</span>
        </>
      ) : (
        <span className="font-semibold text-slate-800">HumanCare Admin Portal</span>
      )}
    </p>
  );
}

export function Topbar({ auth, onOpenMenu }) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onOpenMenu}
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-200 lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Location />
      </div>
      <div className="flex items-center gap-3">
        <AccountBadge admin={auth.admin} isSuperadmin={auth.isSuperadmin} />
        <Button variant="secondary" size="sm" onClick={auth.logout} disabled={auth.loggingOut}>
          <LogOut className="h-4 w-4" />
          Log out
        </Button>
      </div>
    </header>
  );
}
