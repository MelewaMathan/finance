import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Attaches a correlation id to every request. The id is returned in the
 * X-Request-Id header and written to the audit log so a client-visible error
 * can be tied to a specific audit row during a dispute.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/** Best-effort client IP (honours X-Forwarded-For behind a proxy). */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? null;
}

export function userAgent(req: Request): string | null {
  const value = req.headers['user-agent'];
  return typeof value === 'string' ? value.slice(0, 400) : null;
}
