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
 * Reading the queue is lender/auditor only; acting on it is the lender's,
 * because the lender is the account holder for the money. An auditor reviews
 * the reviewer -- which only works if the auditor cannot quietly clear their
 * own findings.
 */
export const fraudRouter = Router();

fraudRouter.get('/fraud/summary', requireAuth, requireRole('lender', 'auditor'), async (req, res) => {
  res.json({ summary: await getFraudSummary(req.user!) });
});

fraudRouter.get(
  '/fraud/flags',
  requireAuth,
  requireRole('lender', 'auditor'),
  validate(flagQuerySchema, 'query'),
  async (req, res) => {
    const flags = await listFlags(req.user!, req.query as unknown as Parameters<typeof listFlags>[1]);
    res.json({ flags, count: flags.length });
  },
);

fraudRouter.post(
  '/fraud/flags/:id/resolve',
  requireAuth,
  requireRole('lender'),
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
  requireRole('lender'),
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
