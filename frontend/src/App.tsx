import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, PublicSupportLayout } from './components/AppShell';
import { FullPageLoader } from './components/ui';
import { homeFor, useAuth } from './lib/auth';
import { LoginPage } from './pages/auth/LoginPage';
import { RegisterPage } from './pages/auth/RegisterPage';
import { ProfilePage } from './pages/ProfilePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { HelpContactPage } from './pages/HelpContactPage';
import { FaqsPage } from './pages/FaqsPage';
import { BorrowerDashboard } from './pages/borrower/BorrowerDashboard';
import { ApplyLoanPage } from './pages/borrower/ApplyLoanPage';
import { MyLoansPage } from './pages/borrower/MyLoansPage';
import { StaffDashboard } from './pages/staff/StaffDashboard';
import { ApplicationsPage } from './pages/staff/ApplicationsPage';
import { FraudQueuePage } from './pages/staff/FraudQueuePage';
import { LoanDetailPage } from './pages/shared/LoanDetailPage';
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { AuditLogPage } from './pages/admin/AuditLogPage';
import { TimelinePage } from './pages/admin/TimelinePage';
import { IntegrityPage } from './pages/admin/IntegrityPage';
import { AccessRequestsPage } from './pages/admin/AccessRequestsPage';
import { SetPasswordPage } from './pages/auth/SetPasswordPage';
import { AdminsPage } from './pages/admin/AdminsPage';
import { LoanSettingsPage } from './pages/admin/LoanSettingsPage';

/** Blocks the app until the session is known; redirects anonymous users. */
function RequireAuth({ children, allowPasswordChange = false }: { children: ReactNode; allowPasswordChange?: boolean }) {
  const { status, user, mustChangePassword } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  if (mustChangePassword && !allowPasswordChange) return <Navigate to="/set-password" replace />;
  if (!mustChangePassword && allowPasswordChange && user) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

/** Prevents a signed-in user from opening another role's screens. */
function RequireRole({ role, children }: { role: 'borrower' | 'staff' | 'admin'; children: ReactNode }) {
  const { user, status } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function SupportShell() {
  const { user, status } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  if (user) return <AppShell />;
  return <PublicSupportLayout />;
}

function RootRedirect() {
  const { status, user, mustChangePassword } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'anonymous' || !user) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/set-password" replace />;
  return <Navigate to={homeFor(user.role)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/set-password"
        element={
          <RequireAuth allowPasswordChange>
            <SetPasswordPage />
          </RequireAuth>
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/profile" element={<ProfilePage />} />

        <Route
          path="/borrower"
          element={
            <RequireRole role="borrower">
              <BorrowerDashboard />
            </RequireRole>
          }
        />
        <Route
          path="/borrower/apply"
          element={
            <RequireRole role="borrower">
              <ApplyLoanPage />
            </RequireRole>
          }
        />
        <Route
          path="/borrower/apply/:loanType"
          element={
            <RequireRole role="borrower">
              <ApplyLoanPage />
            </RequireRole>
          }
        />
        <Route
          path="/borrower/loans"
          element={
            <RequireRole role="borrower">
              <MyLoansPage />
            </RequireRole>
          }
        />
        <Route
          path="/borrower/loans/:id"
          element={
            <RequireRole role="borrower">
              <LoanDetailPage />
            </RequireRole>
          }
        />

        <Route
          path="/staff"
          element={
            <RequireRole role="staff">
              <StaffDashboard />
            </RequireRole>
          }
        />
        <Route
          path="/staff/applications"
          element={
            <RequireRole role="staff">
              <ApplicationsPage />
            </RequireRole>
          }
        />
        <Route
          path="/staff/loans/:id"
          element={
            <RequireRole role="staff">
              <LoanDetailPage />
            </RequireRole>
          }
        />
        <Route
          path="/staff/fraud"
          element={
            <RequireRole role="staff">
              <FraudQueuePage />
            </RequireRole>
          }
        />

        <Route
          path="/admin"
          element={
            <RequireRole role="admin">
              <AdminDashboard />
            </RequireRole>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <RequireRole role="admin">
              <AuditLogPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/timeline"
          element={
            <RequireRole role="admin">
              <TimelinePage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/integrity"
          element={
            <RequireRole role="admin">
              <IntegrityPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/access-requests"
          element={
            <RequireRole role="admin">
              <AccessRequestsPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/admins"
          element={
            <RequireRole role="admin">
              <AdminsPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/loan-settings"
          element={
            <RequireRole role="admin">
              <LoanSettingsPage />
            </RequireRole>
          }
        />
      </Route>

      {/* Support & Public Information pages */}
      <Route element={<SupportShell />}>
        <Route path="/help" element={<HelpContactPage />} />
        <Route path="/faqs" element={<FaqsPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
