import {
  LayoutDashboard,
  Building2,
  ClipboardCheck,
  FilePen,
  FileSearch,
  Briefcase,
  Receipt,
  Stethoscope,
  Users,
  LifeBuoy,
  ShieldCheck,
  KeyRound,
} from 'lucide-react';

// `access` mirrors the backend: 'any' (every admin), 'corporateReview' (superadmin or an
// admin granted review), 'superadmin'. It only controls what the UI shows — the server
// enforces it on every request.
export const NAV_ITEMS = [
  { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, group: 'Operations', access: 'any' },
  { label: 'Corporates', path: '/corporates', icon: Building2, group: 'Network', access: 'any' },
  { label: 'Partner Applications', path: '/registrations', icon: ClipboardCheck, group: 'Network', access: 'corporateReview' },
  // `exclude`: sub-paths that belong to another item, so only one of the two is highlighted.
  { label: 'Incomplete Submissions', path: '/requests', icon: FileSearch, group: 'Operations', access: 'any', exclude: ['/requests/drafts'] },
  { label: 'Drafts', path: '/requests/drafts', icon: FilePen, group: 'Operations', access: 'any' },
  { label: 'Cases', path: '/cases', icon: Briefcase, group: 'Operations', access: 'any' },
  { label: 'Billing', path: '/billing', icon: Receipt, group: 'Finance & Support', access: 'any' },
  { label: 'Services', path: '/services', icon: Stethoscope, group: 'Finance & Support', access: 'any' },
  { label: 'Patients', path: '/patients', icon: Users, group: 'Network', access: 'any' },
  { label: 'Support Tickets', path: '/support', icon: LifeBuoy, group: 'Finance & Support', access: 'any' },
  { label: 'Admins', path: '/admins', icon: ShieldCheck, group: 'Administration', access: 'superadmin' },
  { label: 'Recovery', path: '/recovery', icon: KeyRound, group: 'Administration', access: 'superadmin' },
];

// Sections of the sidebar, in display order. Items keep the order they have in NAV_ITEMS within a section.
export const NAV_GROUPS = ['Operations', 'Network', 'Finance & Support', 'Administration'];

/** The visible items split into sections (empty sections are left out). */
export function groupNavItems(items) {
  return NAV_GROUPS.map((label) => ({ label, items: items.filter((i) => i.group === label) })).filter((g) => g.items.length > 0);
}

export function canAccess(access, auth) {
  if (access === 'superadmin') return auth.isSuperadmin;
  if (access === 'corporateReview') return auth.canReviewCorporates;
  return true;
}
