import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';

const VERCEL_PREVIEW_ORIGIN = /^https:\/\/finance-[a-z0-9]+-rotichmathan-4403\.vercel\.app$/;

export interface CorsOriginPolicy {
  allowedOrigins: ReadonlySet<string>;
  allowVercelPreviews: boolean;
}

export function createCorsOriginPolicy(options: {
  configuredOrigins: string;
  allowVercelPreviews: boolean;
  isProduction: boolean;
}): CorsOriginPolicy {
  const allowedOrigins = new Set(
    options.configuredOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  if (!options.isProduction) {
    allowedOrigins.add('http://127.0.0.1:5173');
    allowedOrigins.add('http://localhost:5173');
  }

  return {
    allowedOrigins,
    allowVercelPreviews: options.allowVercelPreviews,
  };
}

export function isCorsOriginAllowed(origin: string, policy: CorsOriginPolicy): boolean {
  return policy.allowedOrigins.has(origin) || (policy.allowVercelPreviews && VERCEL_PREVIEW_ORIGIN.test(origin));
}

export function createCorsMiddleware(policy: CorsOriginPolicy) {
  return cors({
    origin(origin, callback) {
      callback(null, !origin || isCorsOriginAllowed(origin, policy));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
}

export function createCorsOriginGuard(policy: CorsOriginPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('Origin');
    if (!origin || isCorsOriginAllowed(origin, policy)) {
      next();
      return;
    }

    console.warn('[cors] blocked origin', origin);
    res.status(403).json({
      error: {
        code: 'CORS_ORIGIN_DENIED',
        message: 'Origin not allowed by CORS',
      },
    });
  };
}
