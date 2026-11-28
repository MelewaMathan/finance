import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { setAccessToken } from '../../lib/api';
import { pollApprovalStatus, type AwaitingApprovalResponse } from '../../lib/loginApproval';

const POLL_INTERVAL_MS = 4_000;

interface Props {
  pending: AwaitingApprovalResponse;
  onCancel: () => void;
}

function useCountdown(expiresAt: string) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)),
  );
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Shown after a staff member submits correct credentials.
 * Polls the server every 4 seconds and redirects once approved.
 * Borrowers and Auditors never reach this screen.
 */
export function AwaitingApprovalScreen({ pending, onCancel }: Props) {
  const { applyApprovedSession } = useAuth();
  const [denied, setDenied] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countdown = useCountdown(pending.expiresAt);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const result = await pollApprovalStatus(pending.requestId, pending.pollToken);
        if (!isMounted.current) return;

        if (result.status === 'approved') {
          // Server set the refresh cookie; now apply the session in memory.
          setAccessToken(result.accessToken);
          await applyApprovedSession({
            user: result.user as Parameters<typeof applyApprovedSession>[0]['user'],
            accessToken: result.accessToken,
          });
          return; // navigate handled by App.tsx RequireAuth → homeFor
        }

        if (result.status === 'denied') {
          setDenied(result.reason ?? 'Your login request was denied.');
          return;
        }

        if (result.status === 'expired' || result.status === 'used') {
          setExpired(true);
          return;
        }

        // Still pending — schedule next poll.
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (!isMounted.current) return;
        setError('Could not check approval status. Retrying…');
        timer = setTimeout(poll, POLL_INTERVAL_MS * 2);
      }
    }

    // Start first poll after a short delay so we don't hit the server
    // immediately on mount.
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [pending.requestId, pending.pollToken, applyApprovedSession]);

  if (denied) {
    return (
      <div className="card p-6 sm:p-8 w-full max-w-md">
        <h1 className="text-xl font-semibold text-slate-900">Login request denied</h1>
        <p className="mt-2 text-sm text-slate-600">{denied}</p>
        <button type="button" className="btn-primary mt-6 w-full" onClick={onCancel}>
          Try again
        </button>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="card p-6 sm:p-8 w-full max-w-md">
        <h1 className="text-xl font-semibold text-slate-900">Request expired</h1>
        <p className="mt-2 text-sm text-slate-600">
          No admin approved the request within the time limit. Please sign in again.
        </p>
        <button type="button" className="btn-primary mt-6 w-full" onClick={onCancel}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="card p-6 sm:p-8 w-full max-w-md">
      <div className="flex items-center gap-3">
        <Spinner label="Waiting for approval" />
        <h1 className="text-xl font-semibold text-slate-900">Waiting for admin approval</h1>
      </div>

      <p className="mt-3 text-sm text-slate-600">
        Your account is already signed in on another device. For your security,{' '}
        <strong>both devices have been logged out</strong> and an administrator must approve
        this login before you can access the dashboard.
      </p>

      <div className="mt-5 rounded-xl bg-slate-50 p-4 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Request expires in
        </p>
        <p
          className={`mt-1 text-3xl font-mono font-semibold ${
            countdown === '00:00' ? 'text-red-600' : 'text-slate-900'
          }`}
        >
          {countdown}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Requested at {new Date(pending.expiresAt).toLocaleTimeString()}
        </p>
      </div>

      {error ? <Alert tone="warning" className="mt-4">{error}</Alert> : null}

      <p className="mt-4 text-xs text-slate-500 text-center">
        Checking every few seconds automatically…
      </p>

      <button
        type="button"
        className="mt-5 w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
