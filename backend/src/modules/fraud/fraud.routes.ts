import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../loans/loan.schemas';
import {
  alertQuerySchema,
  flagQuerySchema,
  holdDecisionSchema,
  resolveFlagSchema,
} from './fraud.schemas';
import {
  getFraudSummary,
  listAlerts,
  listFlags,
  listLoanFlags,
  markAlertRead,
  resolveFlag,
  resolveHold,
} from './fraud.service';

/**
 * Fraud review + alert routes (M6).
 *
 * Reading the queue is staff/admin only; acting on it is institution staff's
 * responsibility because staff act for the institution. An admin
 * reviews the reviewer while remaining read-only.
 */
export const fraudRouter = Router();

fraudRouter.get('/fraud/summary', requireAuth, requireRole('staff', 'admin'), async (req, res) => {
  res.json({ summary: await getFraudSummary(req.user!) });
});

fraudRouter.get(
  '/fraud/flags',
  requireAuth,
  requireRole('staff', 'admin'),
  validate(flagQuerySchema, 'query'),
  async (req, res) => {
    const flags = await listFlags(req.user!, req.query as unknown as Parameters<typeof listFlags>[1]);
    res.json({ flags, count: flags.length });
  },
);

fraudRouter.post(
  '/fraud/flags/:id/resolve',
  requireAuth,
  requireRole('staff'),
  validate(idParamSchema, 'params'),
  validate(resolveFlagSchema, 'body'),
  async (req, res) => {
    const flag = await resolveFlag(req.user!, req.params.id as string, req.body, req);
    res.json({ flag });
  },
);

fraudRouter.get('/loans/:id/flags', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  const flags = await listLoanFlags(req.user!, req.params.id as string);
  res.json({ flags, count: flags.length });
});

fraudRouter.post(
  '/loans/:id/holds/resolve',
  requireAuth,
  requireRole('staff'),
  validate(idParamSchema, 'params'),
  validate(holdDecisionSchema, 'body'),
  async (req, res) => {
    const result = await resolveHold(req.user!, req.params.id as string, req.body, req);
    res.json(result);
  },
);

fraudRouter.get('/alerts', requireAuth, validate(alertQuerySchema, 'query'), async (req, res) => {
  const unreadOnly = (req.query as unknown as { unread: 'true' | 'false' }).unread === 'true';
  res.json(await listAlerts(req.user!, unreadOnly));
});

fraudRouter.post('/alerts/:id/read', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  const alert = await markAlertRead(req.user!, req.params.id as string);
  res.json({ alert });
});
