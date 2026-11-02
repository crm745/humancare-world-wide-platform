import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout';
import { PageLoader } from '@/components/ui/Loading';
import { ProtectedRoute, PublicOnlyRoute, RequireAccess } from './guards';
import { ForbiddenPage, NotFoundPage } from './StatusPages';

// Pages are code-split so the login screen doesn't download the whole portal.
const LoginPage = lazy(() => import('@/features/auth/pages/LoginPage'));
const DashboardPage = lazy(() => import('@/features/dashboard/pages/DashboardPage'));
const CorporatesPage = lazy(() => import('@/features/corporates/pages/CorporatesPage'));
const RegistrationsPage = lazy(() => import('@/features/registrations/pages/RegistrationsPage'));
const CasesPage = lazy(() => import('@/features/cases/pages/CasesPage'));
const BillingPage = lazy(() => import('@/features/billing/pages/BillingPage'));
const ServicesPage = lazy(() => import('@/features/services/pages/ServicesPage'));
const PatientsPage = lazy(() => import('@/features/patients/pages/PatientsPage'));
const SupportPage = lazy(() => import('@/features/support/pages/SupportPage'));
const AdminsPage = lazy(() => import('@/features/admins/pages/AdminsPage'));

export function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="/login"
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          }
        />

        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/corporates" element={<CorporatesPage />} />
          <Route
            path="/registrations"
            element={
              <RequireAccess access="corporateReview">
                <RegistrationsPage />
              </RequireAccess>
            }
          />
          <Route path="/cases" element={<CasesPage />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/patients" element={<PatientsPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route
            path="/admins"
            element={
              <RequireAccess access="superadmin">
                <AdminsPage />
              </RequireAccess>
            }
          />
          <Route path="/forbidden" element={<ForbiddenPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
