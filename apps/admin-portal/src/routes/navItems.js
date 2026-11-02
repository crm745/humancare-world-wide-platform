import {
  LayoutDashboard,
  Building2,
  ClipboardCheck,
  Briefcase,
  Receipt,
  Stethoscope,
  Users,
  LifeBuoy,
  ShieldCheck,
} from 'lucide-react';

// `access` mirrors the backend: 'any' (every admin), 'corporateReview' (superadmin or an
// admin granted review), 'superadmin'. It only controls what the UI shows — the server
// enforces it on every request.
export const NAV_ITEMS = [
  { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, access: 'any' },
  { label: 'Corporates', path: '/corporates', icon: Building2, access: 'any' },
  { label: 'Partner Applications', path: '/registrations', icon: ClipboardCheck, access: 'corporateReview' },
  { label: 'Cases', path: '/cases', icon: Briefcase, access: 'any' },
  { label: 'Billing', path: '/billing', icon: Receipt, access: 'any' },
  { label: 'Services', path: '/services', icon: Stethoscope, access: 'any' },
  { label: 'Patients', path: '/patients', icon: Users, access: 'any' },
  { label: 'Support Tickets', path: '/support', icon: LifeBuoy, access: 'any' },
  { label: 'Admins', path: '/admins', icon: ShieldCheck, access: 'superadmin' },
];

export function canAccess(access, auth) {
  if (access === 'superadmin') return auth.isSuperadmin;
  if (access === 'corporateReview') return auth.canReviewCorporates;
  return true;
}
