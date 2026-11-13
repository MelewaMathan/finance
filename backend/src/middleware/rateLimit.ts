import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { isTest } from '../config/env';

/**
 * Rate limiting is a first line of defence against credential stuffing,
 * application spam and scraping of the audit log. The limiters are bypassed
 * under NODE_ENV=test so test suites are deterministic.
 */
const keyFromIp = (req: Request) => req.ip ?? 'unknown';

const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

const globalLimiterImpl = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyFromIp,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } },
});

/** Tighter bucket for auth: IP + submitted email, to slow down brute force. */
const authLimiterImpl = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
    return `${req.ip}|${email}`;
  },
  message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts' } },
});

const writeLimiterImpl = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'unknown',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many write operations' } },
});

export const globalLimiter = isTest ? passthrough : globalLimiterImpl;
export const authLimiter = isTest ? passthrough : authLimiterImpl;
export const writeLimiter = isTest ? passthrough : writeLimiterImpl;

/** Helper so routes read declaratively. */
export const limitWrites = (req: Request, res: Response, next: NextFunction) => writeLimiter(req, res, next);
