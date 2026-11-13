import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import yaml from 'js-yaml';
import swaggerUi from 'swagger-ui-express';
import { config } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requestContext } from './middleware/requestContext';
import { globalLimiter } from './middleware/rateLimit';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { loansRouter } from './modules/loans/loan.routes';
import { repaymentsRouter } from './modules/repayments/repayment.routes';
import { ledgerRouter } from './modules/ledger/ledger.routes';
import { scoringRouter } from './modules/scoring/scoring.routes';
import { fraudRouter } from './modules/fraud/fraud.routes';
import { auditRouter } from './modules/audit/audit.routes';

/**
 * Express application factory.
 *
 * Kept separate from server.ts so tests can mount the app without binding a
 * port. Middleware order matters: security headers -> CORS -> body parsing ->
 * request id -> rate limit -> routes -> 404 -> error handler.
 */
export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind ALB/Nginx the client IP is in X-Forwarded-For; one proxy hop.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // Swagger UI injects inline scripts; the API itself serves JSON only.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  const allowedOrigins = [
    config.WEB_ORIGIN,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ].filter(Boolean);

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header = same-origin / server-to-server / curl.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use(requestContext);
  app.use(globalLimiter);

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'secure-microfinance-api',
      chainMode: config.CHAIN_MODE,
      time: new Date().toISOString(),
    });
  });

  // OpenAPI docs
  const specPath = path.resolve(__dirname, '..', 'openapi.yaml');
  if (fs.existsSync(specPath)) {
    // CORE_SCHEMA only produces plain JSON-like values (no custom tags, no
    // object construction), so loading the local spec cannot execute anything.
    const spec = yaml.load(fs.readFileSync(specPath, 'utf8'), {
      schema: yaml.CORE_SCHEMA,
    }) as Record<string, unknown>;
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'SecureMicrofinance API' }));
    app.get('/api/openapi.yaml', (_req, res) => res.type('text/yaml').send(fs.readFileSync(specPath, 'utf8')));
  }

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/me', usersRouter);
  app.use('/api/v1', loansRouter);
  app.use('/api/v1', repaymentsRouter);
  app.use('/api/v1', ledgerRouter);
  app.use('/api/v1', scoringRouter);
  app.use('/api/v1', fraudRouter);
  app.use('/api/v1', auditRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
