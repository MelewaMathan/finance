import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, bootstrapSession, setAccessToken, type SessionPayload, type SessionUser } from './api';
import type { AwaitingApprovalResponse } from './loginApproval';

/**
 * Session state for the whole app.
 *
 * On mount we try a silent refresh (httpOnly cookie). If that succeeds the
 * user is restored without any stored credential; otherwise they are
 * anonymous. The access token never reaches localStorage or sessionStorage.
 */
export interface ProfileSummary {
  nationalIdMasked: string | null;
  phoneMasked: string | null;
  occupation: string | null;
  monthlyIncomeCents: number | null;
  completeness?: {
    complete: boolean;
    completed: number;
    total: 4;
    missing: string[];
  };
  staffId?: string | null;
  defaultRateBps?: number;
  maxPrincipalCents?: number;
}

interface AuthContextValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: SessionUser | null;
  profile: ProfileSummary | null;
  mustChangePassword: boolean;
  /**
   * Returns normally for borrowers/admins.
   * Returns { awaitingApproval: true, ... } for staff (server 202).
   * Throws ApiError for all other failures.
   */
  login: (email: string, password: string) => Promise<void | AwaitingApprovalResponse>;
  register: (input: {
    email: string;
    password: string;
    fullName: string;
    role: 'borrower' | 'staff';
    inviteCode?: string;
    staffId?: string;
  }) => Promise<void | { pendingApproval: true }>;
  /** Call this after the approval poll returns 'approved' to establish the session. */
  applyApprovedSession: (payload: SessionPayload) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  const loadProfile = useCallback(async () => {
    try {
      const data = await api<{ profile: ProfileSummary }>('/me/profile');
      setProfile(data.profile);
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await bootstrapSession();
        if (cancelled) return;
        if (session) {
          setUser(session.user);
          setMustChangePassword(session.mustChangePassword === true);
          setStatus('authenticated');
          await loadProfile();
        } else {
          setStatus('anonymous');
        }
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    })();
    return () => { cancelled = true; };
  }, [loadProfile]);

  const applySession = useCallback(
    async (session: SessionPayload, forceChange = false) => {
      setAccessToken(session.accessToken);
      setUser(session.user);
      setMustChangePassword(forceChange);
      setStatus('authenticated');
      await loadProfile();
    },
    [loadProfile],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<void | AwaitingApprovalResponse> => {
      // The server returns HTTP 202 for staff with correct credentials.
      // The api() helper only throws on non-2xx, so we need to detect 202
      // by checking the response body shape.
      const raw = await api<
        | (SessionPayload & { mustChangePassword?: boolean })
        | { status: 'awaiting_approval'; requestId: string; pollToken: string; expiresAt: string }
      >('/auth/login', { method: 'POST', body: { email, password } });

      if ('status' in raw && raw.status === 'awaiting_approval') {
        return raw as AwaitingApprovalResponse;
      }

      // Borrower / Admin — normal session.
      const sp = raw as SessionPayload & { mustChangePassword?: boolean };
      await applySession(sp, sp.mustChangePassword === true);
    },
    [applySession],
  );

  /** Called by the approval-polling screen once the admin approves. */
  const applyApprovedSession = useCallback(
    async (payload: SessionPayload) => {
      await applySession(payload);
    },
    [applySession],
  );

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      fullName: string;
      role: 'borrower' | 'staff';
      inviteCode?: string;
      staffId?: string;
    }) => {
      const session = await api<
        SessionPayload | { status: 'pending_approval'; user: SessionPayload['user'] }
      >('/auth/register', { method: 'POST', body: input });
      if (!('accessToken' in session)) {
        return { pendingApproval: true as const };
      }
      await applySession(session);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await api<void>('/auth/logout', { method: 'POST', retryOn401: false });
    } finally {
      setAccessToken(null);
      setUser(null);
      setProfile(null);
      setMustChangePassword(false);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, profile, mustChangePassword, login, register, applyApprovedSession, logout, refreshProfile: loadProfile }),
    [status, user, profile, mustChangePassword, login, register, applyApprovedSession, logout, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** Landing route per role. */
export function homeFor(role: SessionUser['role']): string {
  switch (role) {
    case 'staff':
      return '/enterprise';
    case 'admin':
      return '/admin';
    default:
      return '/borrower';
  }
}

export const ROLE_LABEL: Record<SessionUser['role'], string> = {
  borrower: 'Borrower',
  staff: 'Staff',
  admin: 'Forensic admin',
};
