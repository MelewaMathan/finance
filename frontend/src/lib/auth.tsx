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
  staffId?: string | null;
  defaultRateBps?: number;
  maxPrincipalCents?: number;
}

interface AuthContextValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: SessionUser | null;
  profile: ProfileSummary | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    fullName: string;
    role: 'borrower' | 'staff';
    inviteCode?: string;
    staffId?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      const data = await api<{ profile: ProfileSummary }>('/me/profile');
      setProfile(data.profile);
    } catch {
      // A missing profile should never block the app; the pages show a hint.
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
          setStatus('authenticated');
          await loadProfile();
        } else {
          setStatus('anonymous');
        }
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProfile]);

  const applySession = useCallback(
    async (session: SessionPayload) => {
      setAccessToken(session.accessToken);
      setUser(session.user);
      setStatus('authenticated');
      await loadProfile();
    },
    [loadProfile],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const session = await api<SessionPayload>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      await applySession(session);
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
      const session = await api<SessionPayload>('/auth/register', { method: 'POST', body: input });
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
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, profile, login, register, logout, refreshProfile: loadProfile }),
    [status, user, profile, login, register, logout, loadProfile],
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
    case 'auditor':
      return '/auditor';
    default:
      return '/borrower';
  }
}

export const ROLE_LABEL: Record<SessionUser['role'], string> = {
  borrower: 'Borrower',
  staff: 'Staff',
  auditor: 'Forensic auditor',
};
