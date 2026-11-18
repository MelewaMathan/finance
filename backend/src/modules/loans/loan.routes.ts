import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditRequest } from '../audit/audit.service';
import { getProfileCompleteness } from '../users/users.service';
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

async function requireCompleteBorrowerProfile(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const completeness = await getProfileCompleteness(req.user!.id);
  if (!completeness.complete) {
    await auditRequest(req, 'loan.application_blocked', 'borrower_profile', req.user!.id, {
      missing: completeness.missing,
    });
    res.status(403).json({
      code: 'PROFILE_INCOMPLETE',
      message: 'Complete your profile before applying for a loan.',
      missing: completeness.missing,
    });
    return;
  }
  next();
}

loansRouter.get('/lenders', requireAuth, async (_req, res) => {
  res.json({ items: await listLenderOptions() });
});

loansRouter.post(
  '/loans',
  requireAuth,
  requireRole('borrower'),
  requireCompleteBorrowerProfile,
  validate(applyLoanSchema),
  async (req, res) => {
    const loan = await createApplication(req.user!, req.body as ApplyLoanInput, req);
    res.status(201).json({ loan });
  },
);

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
