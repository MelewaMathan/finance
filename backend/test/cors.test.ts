import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCorsMiddleware,
  createCorsOriginGuard,
  createCorsOriginPolicy,
} from '../src/lib/cors';

function createTestApp(allowVercelPreviews: boolean) {
  const policy = createCorsOriginPolicy({
    configuredOrigins: 'https://finance.example.com',
    allowVercelPreviews,
    isProduction: true,
  });
  const app = express();
  app.use(createCorsOriginGuard(policy));
  app.use(createCorsMiddleware(policy));
  app.get('/resource', (_req, res) => res.json({ ok: true }));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CORS origin policy', () => {
  it('reflects an explicitly allowed origin with credentials enabled', async () => {
    const origin = 'https://finance.example.com';
    const response = await request(createTestApp(false)).get('/resource').set('Origin', origin);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects unknown origins with a generic response and warns with the blocked origin', async () => {
    const origin = 'https://unexpected.example.com';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await request(createTestApp(false)).get('/resource').set('Origin', origin);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: 'CORS_ORIGIN_DENIED',
        message: 'Origin not allowed by CORS',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(origin);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[cors] blocked origin', origin);
  });

  it('allows only this project’s Vercel preview pattern when explicitly enabled', async () => {
    const previewOrigin = 'https://finance-1rinsvkrt-rotichmathan-4403.vercel.app';
    const disabled = await request(createTestApp(false)).get('/resource').set('Origin', previewOrigin);
    const enabled = await request(createTestApp(true)).get('/resource').set('Origin', previewOrigin);
    const otherProject = await request(createTestApp(true))
      .get('/resource')
      .set('Origin', 'https://finance-1rinsvkrt-someone-else.vercel.app');

    expect(disabled.status).toBe(403);
    expect(enabled.status).toBe(200);
    expect(enabled.headers['access-control-allow-origin']).toBe(previewOrigin);
    expect(otherProject.status).toBe(403);
  });

  it('continues to serve requests that have no Origin header', async () => {
    const response = await request(createTestApp(false)).get('/resource');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
