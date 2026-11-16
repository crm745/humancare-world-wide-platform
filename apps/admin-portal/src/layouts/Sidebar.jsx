import { Link, NavLink, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import logo from '@/assets/logo.png';
import { cn } from '@/utils/cn';
import { groupNavItems } from '@/routes/navItems';

// Presentation of the portal's navigation. Which items appear (and where they lead) is decided by
// routes/navItems.js and the role filter in AppLayout; nothing here changes either.

const NAV_ITEM_CLASS = (active) =>
  cn(
    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
    active ? 'bg-gradient-to-r from-accent-600 to-accent-700 text-white shadow-sm' : 'text-white/75 hover:bg-white/10 hover:text-white',
  );

// A normal item is a NavLink (active on its path and everything below it). An item with
// `exclude` owns a sub-path that has its own item (Drafts under Incomplete Submissions), so it
// works out "active" itself: that way the highlight and aria-current agree and only one shows.
function NavItem({ item, pathname, onNavigate }) {
  const { label, path, icon: Icon, exclude } = item;
  const content = (
    <>
      <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </>
  );
  if (!exclude) {
    return (
      <NavLink to={path} onClick={onNavigate} className={({ isActive }) => NAV_ITEM_CLASS(isActive)}>
        {content}
      </NavLink>
    );
  }
  const under = (base) => pathname === base || pathname.startsWith(`${base}/`);
  const active = under(path) && !exclude.some(under);
  return (
    <Link to={path} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={NAV_ITEM_CLASS(active)}>
      {content}
    </Link>
  );
}

export function NavList({ items, onNavigate }) {
  const { pathname } = useLocation();
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-5" aria-label="Main navigation">
      {groupNavItems(items).map((group) => {
        const headingId = `nav-group-${group.label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
        return (
          <div key={group.label} className="mb-6 last:mb-0">
            <p id={headingId} className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">
              {group.label}
            </p>
            <ul className="space-y-0.5" aria-labelledby={headingId}>
              {group.items.map((item) => (
                <li key={item.path}>
                  <NavItem item={item} pathname={pathname} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

// One full-width bar, so its bottom border spans the whole panel; the close button (drawer
// only) sits at the right end of the same row. The logo sits on a white tile so its dark lettering stays readable.
export function BrandBar({ onClose }) {
  return (
    <div className="flex h-20 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-5">
      <div className="flex items-center gap-3">
        <span className="flex h-12 items-center rounded-xl bg-white px-2.5 shadow-sm">
          <img src={logo} alt="HumanCare" className="h-9 w-auto" />
        </span>
        <span className="text-[11px] font-semibold uppercase leading-tight tracking-[0.18em] text-white/70">
          Admin
          <br />
          Portal
        </span>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
