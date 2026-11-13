import type { Response } from 'express';
import { config } from '../config/env';

/**
 * The refresh token lives in an httpOnly cookie so JavaScript (and therefore
 * any XSS payload) cannot read it. SameSite=Strict blocks CSRF on the
 * refresh/logout endpoints; the access token is sent explicitly instead.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}
