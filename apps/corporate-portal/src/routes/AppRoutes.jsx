import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from '@/layouts/DashboardLayout';
import { RegistrationLayout } from '@/layouts/RegistrationLayout';
import { PageLoader } from '@/components/ui/Loading';
import { useAuth } from '@/hooks/useAuth';
import { PasswordChangeRoute, ProtectedRoute, PublicOnlyRoute } from './guards';
import { RegistrationIndex } from '@/pages/register/RegistrationContext';

// Pages are code-split so the login screen doesn't download charts and tables.
const LoginPage = lazy(() => import('@/pages/auth/LoginPage'));
const VerifyOtpPage = lazy(() => import('@/pages/auth/VerifyOtpPage'));
const ForgotPasswordPage = lazy(() => import('@/pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('@/pages/auth/ResetPasswordPage'));
const FirstLoginPasswordPage = lazy(() => import('@/pages/auth/FirstLoginPasswordPage'));

const CompanyStep = lazy(() => import('@/pages/register/CompanyStep'));
const BankStep = lazy(() => import('@/pages/register/BankStep'));
const DocumentsStep = lazy(() => import('@/pages/register/DocumentsStep'));
const SubmittedPage = lazy(() => import('@/pages/register/SubmittedPage'));
const VerifyEmailPage = lazy(() => import('@/pages/register/VerifyEmailPage'));
const CredentialsPage = lazy(() => import('@/pages/register/CredentialsPage'));
const AccountCreatedPage = lazy(() => import('@/pages/register/AccountCreatedPage'));

const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage'));
const CompanyProfilePage = lazy(() => import('@/pages/account/CompanyProfilePage'));
const ServicesPage = lazy(() => import('@/pages/services/ServicesPage'));
const CasesPage = lazy(() => import('@/pages/cases/CasesPage'));
const CaseDetailPage = lazy(() => import('@/pages/cases/CaseDetailPage'));
const PatientsPage = lazy(() => import('@/pages/patients/PatientsPage'));
const PatientProfilePage = lazy(() => import('@/pages/patients/PatientProfilePage'));
const DocumentsPage = lazy(() => import('@/pages/documents/DocumentsPage'));
const InvoicesPage = lazy(() => import('@/pages/billing/InvoicesPage'));
const PaymentsPage = lazy(() => import('@/pages/billing/PaymentsPage'));
const BankDetailsPage = lazy(() => import('@/pages/billing/BankDetailsPage'));
const NotificationsPage = lazy(() => import('@/pages/account/NotificationsPage'));
const SupportPage = lazy(() => import('@/pages/account/SupportPage'));
const SettingsPage = lazy(() => import('@/pages/account/SettingsPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

function HomeRedirect() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route
          path="/login"
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          }
        />
        <Route path="/verify-otp" element={<VerifyOtpPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route
          path="/change-password-required"
          element={
            <PasswordChangeRoute>
              <FirstLoginPasswordPage />
            </PasswordChangeRoute>
          }
        />

        {/* New corporate: company → bank → documents → submitted (Corporate ID) → email → credentials → active */}
        <Route
          path="/register"
          element={
            <PublicOnlyRoute>
              <RegistrationLayout />
            </PublicOnlyRoute>
          }
        >
          <Route index element={<RegistrationIndex />} />
          <Route path="company" element={<CompanyStep />} />
          <Route path="bank" element={<BankStep />} />
          <Route path="documents" element={<DocumentsStep />} />
          <Route path="submitted" element={<SubmittedPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />
          <Route path="credentials" element={<CredentialsPage />} />
          <Route path="success" element={<AccountCreatedPage />} />
        </Route>

        <Route
          element={
            <ProtectedRoute>
              <DashboardLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/profile" element={<CompanyProfilePage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/cases" element={<CasesPage />} />
          <Route path="/cases/:caseId" element={<CaseDetailPage />} />
          <Route path="/patients" element={<PatientsPage />} />
          <Route path="/patients/:patientId" element={<PatientProfilePage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/bank-details" element={<BankDetailsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
