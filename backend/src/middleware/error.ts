import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { config } from '../config/env';

/** 404 for unknown API routes (never leaks the route table). */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint', requestId: _req.requestId } });
}

/**
 * Central error handler.
 *
 * - AppError -> its status/code/message
 * - ZodError -> 400 with field-level issues
 * - PostgreSQL unique violation -> 409 (no SQL text echoed back)
 * - anything else -> generic 500; details only in server logs
 */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  if (error instanceof AppError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details, requestId },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        requestId,
      },
    });
    return;
  }

  const pgError = error as { code?: string; constraint?: string; detail?: string };
  if (pgError.code === '23505') {
    res.status(409).json({
      error: {
        code: 'DUPLICATE',
        message: 'That record already exists',
        details: pgError.constraint ? { constraint: pgError.constraint } : undefined,
        requestId,
      },
    });
    return;
  }
  if (pgError.code === '23514' || pgError.code === '23503') {
    res.status(422).json({
      error: { code: 'CONSTRAINT_VIOLATION', message: 'The record violates a data rule', requestId },
    });
    return;
  }
  if (pgError.code === '23001' || pgError.code === '23000') {
    res.status(409).json({
      error: { code: 'APPEND_ONLY', message: 'This record is append-only', requestId },
    });
    return;
  }

  console.error(`[error] ${requestId} ${req.method} ${req.originalUrl}`, error);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Quote the request id when contacting support.',
      // Config leakage is limited to non-secret metadata.
      details: config.isProduction ? undefined : { hint: (error as Error)?.message },
      requestId,
    },
  });
}
