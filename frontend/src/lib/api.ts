/**
 * Thin API client.
 *
 * - The access token is held in memory only (never localStorage), so an XSS
 *   payload cannot steal a long-lived credential.
 * - The refresh token is an httpOnly cookie sent with `credentials: include`.
 * - A 401 triggers exactly one refresh attempt, shared by all in-flight
 *   calls, then the original request is retried once.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let accessToken: string | null = null;
let bootstrapInFlight: Promise<SessionPayload | null> | null = null;


export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  retryOn401?: boolean;
}

async function rawRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as { error?: ApiErrorBody } | null;

  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return payload as T;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { retryOn401 = true } = options;

  try {
    return await rawRequest<T>(path, options);
  } catch (error) {
    const isAuthPath = path.startsWith('/auth/');
    if (error instanceof ApiError && error.status === 401 && retryOn401 && !isAuthPath) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return rawRequest<T>(path, options);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('smf:session-revoked'));
      }
    }
    throw error;
  }
}

export type StaffTier = 'regular' | 'supervisor' | 'finance_manager';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: 'borrower' | 'staff' | 'admin';
  staffTier?: StaffTier | null;
  createdAt?: string;
}

export interface SessionPayload {
  user: SessionUser;
  accessToken: string;
  mustChangePassword?: boolean;
}

/**
 * Exchanges the refresh cookie for a new access token.
 *
 * Every caller shares one in-flight request: React StrictMode mounts effects
 * twice in development and a multi-widget page can fire several API calls at
 * once, and two parallel rotations with the same cookie would look like token
 * reuse on the server. One request, one rotation.
 */
export async function refreshAccessToken(): Promise<boolean> {
  const session = await bootstrapSession();
  return session !== null;
}

/** Returns the fresh session (user + token) or null when not signed in. */
export function bootstrapSession(): Promise<SessionPayload | null> {
  if (!bootstrapInFlight) {
    bootstrapInFlight = (async (): Promise<SessionPayload | null> => {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        accessToken = null;
        return null;
      }
      const data = (await response.json()) as SessionPayload;
      accessToken = data.accessToken;
      return data;
    })().finally(() => {
      bootstrapInFlight = null;
    });
  }
  return bootstrapInFlight;
}
