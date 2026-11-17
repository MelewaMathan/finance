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
import { AuditorDashboard } from './pages/auditor/AuditorDashboard';
import { AuditLogPage } from './pages/auditor/AuditLogPage';
import { TimelinePage } from './pages/auditor/TimelinePage';
import { IntegrityPage } from './pages/auditor/IntegrityPage';
import { AccessRequestsPage } from './pages/auditor/AccessRequestsPage';

/** Blocks the app until the session is known; redirects anonymous users. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Prevents a signed-in user from opening another role's screens. */
function RequireRole({ role, children }: { role: 'borrower' | 'staff' | 'auditor'; children: ReactNode }) {
  const { user, status } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function RootRedirect() {
  const { status, user } = useAuth();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'anonymous' || !user) return <Navigate to="/login" replace />;
  return <Navigate to={homeFor(user.role)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

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
          path="/auditor"
          element={
            <RequireRole role="auditor">
              <AuditorDashboard />
            </RequireRole>
          }
        />
        <Route
          path="/auditor/audit"
          element={
            <RequireRole role="auditor">
              <AuditLogPage />
            </RequireRole>
          }
        />
        <Route
          path="/auditor/timeline"
          element={
            <RequireRole role="auditor">
              <TimelinePage />
            </RequireRole>
          }
        />
        <Route
          path="/auditor/integrity"
          element={
            <RequireRole role="auditor">
              <IntegrityPage />
            </RequireRole>
          }
        />
        <Route
          path="/auditor/access-requests"
          element={
            <RequireRole role="auditor">
              <AccessRequestsPage />
            </RequireRole>
          }
        />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
