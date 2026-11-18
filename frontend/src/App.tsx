import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { FullPageLoader } from './components/ui';
import { homeFor, useAuth } from './lib/auth';
import { LoginPage } from './pages/auth/LoginPage';
import { RegisterPage } from './pages/auth/RegisterPage';
import { ProfilePage } from './pages/ProfilePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { BorrowerDashboard } from './pages/borrower/BorrowerDashboard';
import { ApplyLoanPage } from './pages/borrower/ApplyLoanPage';
import { MyLoansPage } from './pages/borrower/MyLoansPage';
import { LenderDashboard as EnterpriseDashboard } from './pages/lender/LenderDashboard';
import { ApplicationsPage } from './pages/lender/ApplicationsPage';
import { FraudQueuePage } from './pages/lender/FraudQueuePage';
import { LoanDetailPage } from './pages/shared/LoanDetailPage';
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { AuditLogPage } from './pages/admin/AuditLogPage';
import { TimelinePage } from './pages/admin/TimelinePage';
import { IntegrityPage } from './pages/admin/IntegrityPage';
import { AccessRequestsPage } from './pages/admin/AccessRequestsPage';
import { SetPasswordPage } from './pages/auth/SetPasswordPage';
import { AdminsPage } from './pages/admin/AdminsPage';

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
          path="/enterprise"
          element={
            <RequireRole role="staff">
              <EnterpriseDashboard />
            </RequireRole>
          }
        />
        <Route
          path="/enterprise/applications"
          element={
            <RequireRole role="staff">
              <ApplicationsPage />
            </RequireRole>
          }
        />
        <Route
          path="/enterprise/loans/:id"
          element={
            <RequireRole role="staff">
              <LoanDetailPage />
            </RequireRole>
          }
        />
        <Route
          path="/enterprise/fraud"
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
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
