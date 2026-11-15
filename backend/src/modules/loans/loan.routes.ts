import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  createApplication,
  decide,
  disburse,
  getAgreementFile,
  getLoan,
  listLenderOptions,
  listLoans,
  verifyIdentity,
} from './loan.service';
import {
  applyLoanSchema,
  decisionSchema,
  disburseSchema,
  idParamSchema,
  loanListQuery,
  type ApplyLoanInput,
  type DecisionInput,
  type DisburseInput,
  type LoanListQuery,
} from './loan.schemas';

/**
 * Loan routes.
 *
 * Authorisation is layered: requireRole gates the endpoint, and the service
 * re-checks that the loan belongs to the caller's book. A lender guessing a
 * UUID from another book gets 404, not 403 -- we do not confirm existence.
 */
export const loansRouter = Router();

const verifySchema = z.object({ note: z.string().trim().max(500).optional() });

loansRouter.get('/lenders', requireAuth, async (_req, res) => {
  res.json({ items: await listLenderOptions() });
});

loansRouter.post('/loans', requireAuth, requireRole('borrower'), validate(applyLoanSchema), async (req, res) => {
  const loan = await createApplication(req.user!, req.body as ApplyLoanInput, req);
  res.status(201).json({ loan });
});

loansRouter.get('/loans', requireAuth, validate(loanListQuery, 'query'), async (req, res) => {
  res.json(await listLoans(req.user!, req.query as unknown as LoanListQuery));
});

loansRouter.get('/loans/:id', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  res.json({ loan: await getLoan(req.user!, req.params.id as string) });
});

loansRouter.post(
  '/loans/:id/verify',
  requireAuth,
  requireRole('staff'),
  validate(idParamSchema, 'params'),
  validate(verifySchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof verifySchema>;
    res.json({ loan: await verifyIdentity(req.user!, req.params.id as string, body.note, req) });
  },
);

loansRouter.post(
  '/loans/:id/decision',
  requireAuth,
  requireRole('staff'),
  validate(idParamSchema, 'params'),
  validate(decisionSchema),
  async (req, res) => {
    const loan = await decide(req.user!, req.params.id as string, req.body as DecisionInput, req);
    res.json({ loan });
  },
);

loansRouter.post(
  '/loans/:id/disburse',
  requireAuth,
  requireRole('staff'),
  validate(idParamSchema, 'params'),
  validate(disburseSchema),
  async (req, res) => {
    const result = await disburse(req.user!, req.params.id as string, req.body as DisburseInput, req);
    res.json(result);
  },
);

loansRouter.get('/loans/:id/agreement', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  const file = await getAgreementFile(req.user!, req.params.id as string, req);
  res.setHeader('X-Document-SHA256', file.sha256);
  res.type(file.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  // Bytes, not a path: the service has already verified them against the
  // recorded digest, and there is no window to swap the file in between.
  res.send(file.bytes);
});
