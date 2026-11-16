import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';
import { PageLoader } from '@/components/ui/Loading';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NAV_ITEMS, canAccess } from '@/routes/navItems';
import { BrandBar, NavList } from './Sidebar';
import { Topbar } from './Topbar';

const SIDEBAR_CLASS = 'bg-navy-900';

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
      <aside className={`fixed inset-y-0 left-0 z-30 hidden w-64 flex-col ${SIDEBAR_CLASS} lg:flex`}>
        <BrandBar />
        <NavList items={items} />
      </aside>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} label="Navigation" panelClassName={SIDEBAR_CLASS}>
        <BrandBar onClose={() => setDrawerOpen(false)} />
        <NavList items={items} onNavigate={() => setDrawerOpen(false)} />
      </Drawer>

      <Topbar auth={auth} onOpenMenu={() => setDrawerOpen(true)} />

      <main className="mx-auto w-full max-w-[96rem] px-4 py-6 sm:px-6">
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
