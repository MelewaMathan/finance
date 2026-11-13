import type { Response } from 'supertest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app';
import { query, queryOne } from '../src/db/pool';
import type { Role } from '../src/types/express';

/** Shared helpers for the API test suites. */

export const app = createApp();
export const PASSWORD = 'Passw0rd!demo';

export interface Session {
  token: string;
  cookie: string;
  userId: string;
}

/** Extracts the refresh cookie as a `name=value` pair usable in a Cookie header. */
export function refreshCookie(response: Response): string {
  const header = response.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const entry = list.find((value) => value.startsWith('smf_refresh='));
  if (!entry) throw new Error('refresh cookie was not set');
  return entry.split(';')[0];
}

export async function register(
  email: string,
  overrides: Partial<{ fullName: string; role: 'borrower' | 'lender'; businessName: string; password: string }> = {},
): Promise<Session> {
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({
      email,
      password: overrides.password ?? PASSWORD,
      fullName: overrides.fullName ?? 'Test User',
      role: overrides.role ?? 'borrower',
      businessName: overrides.businessName,
    });
  if (response.status !== 201) {
    throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { token: response.body.accessToken, cookie: refreshCookie(response), userId: response.body.user.id };
}

export async function login(email: string, password = PASSWORD): Promise<Session> {
  const response = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { token: response.body.accessToken, cookie: refreshCookie(response), userId: response.body.user.id };
}

/**
 * Creates an auditor directly in the database: the public API deliberately
 * cannot mint auditor accounts.
 */
export async function createAuditor(email = 'auditor@test.local'): Promise<Session> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, full_name)
     VALUES ($1, $2, 'auditor', 'Forensic Auditor')
     RETURNING id`,
    [email, passwordHash],
  );
  return login(email);
}

export function authHeader(session: Session): [string, string] {
  return ['Authorization', `Bearer ${session.token}`];
}

export async function setRole(userId: string, role: Role): Promise<void> {
  await query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
}

export { request };
