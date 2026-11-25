import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditRequest } from '../audit/audit.service';
import { idParamSchema } from '../loans/loan.schemas';
import { getChainStatus } from './chain.client';
import { anchorAuditTrail, anchorLoanTransactions, getLoanLedgerReport } from './ledger.service';

/**
 * Ledger routes.
 *
 * Reads are open to every authenticated role -- a borrower is entitled to
 * proof of their own payments. Writes (anchoring) are institution actions and
 * are available to all institution staff.
 */
export const ledgerRouter = Router();

ledgerRouter.get('/ledger/status', requireAuth, async (_req, res) => {
  res.json({ chain: await getChainStatus() });
});

ledgerRouter.get('/loans/:id/proof', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  const report = await getLoanLedgerReport(req.user!, req.params.id as string);
  await auditRequest(req, 'ledger.proof_viewed', 'loan', req.params.id as string, {
    ref: report.loan.ref,
    summary: report.summary,
    ok: report.ok,
  });
  res.json({ report });
});

ledgerRouter.post(
  '/loans/:id/anchor',
  requireAuth,
  requireRole('staff'),
  validate(idParamSchema, 'params'),
  async (req, res) => {
    const result = await anchorLoanTransactions(req.user!, req.params.id as string);
    await auditRequest(req, 'ledger.transactions_anchored', 'loan', req.params.id as string, {
      ...result,
    });
    res.json({ result });
  },
);

ledgerRouter.post('/ledger/audit-anchor', requireAuth, requireRole('staff'), async (req, res) => {
  const result = await anchorAuditTrail(req.user!);
  await auditRequest(req, 'ledger.audit_root_anchored', 'audit_log', null, {
    seq: result.seq,
    root: result.root,
    txHash: result.txHash,
  });
  res.json({ result });
});
