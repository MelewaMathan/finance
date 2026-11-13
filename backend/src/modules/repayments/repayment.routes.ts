import { Router } from 'express';
import { sha256Hex } from '../../lib/crypto';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditRequest } from '../audit/audit.service';
import { idParamSchema } from '../loans/loan.schemas';
import { repaymentSchema, type RepaymentInput } from './repayment.schemas';
import { recordRepayment } from './repayment.service';
import { getStatement, renderStatementPdf, statementCsv } from './statement.service';

/**
 * Repayment and statement routes.
 *
 * A held repayment returns 202: the claim was recorded, the money was not
 * applied, and the lender must review it. That distinction matters in a
 * dispute, so it is explicit in the status code rather than hidden in a
 * success payload.
 */
export const repaymentsRouter = Router();

repaymentsRouter.post(
  '/loans/:id/repayments',
  requireAuth,
  requireRole('lender', 'borrower'),
  validate(idParamSchema, 'params'),
  validate(repaymentSchema),
  async (req, res) => {
    const result = await recordRepayment(req.user!, req.params.id as string, req.body as RepaymentInput, req);
    res.status(result.held ? 202 : 201).json(result);
  },
);

repaymentsRouter.get('/loans/:id/statement', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  const statement = await getStatement(req.user!, req.params.id as string);
  await auditRequest(req, 'statement.generated', 'loan', req.params.id as string, {
    ref: statement.ref,
    format: 'json',
  });
  res.json({ statement });
});

repaymentsRouter.get('/loans/:id/statement.pdf', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  const { pdf, statement } = await renderStatementPdf(req.user!, req.params.id as string);
  await auditRequest(req, 'statement.generated', 'loan', req.params.id as string, {
    ref: statement.ref,
    format: 'pdf',
    sha256: sha256Hex(pdf),
  });
  res.setHeader('X-Document-SHA256', sha256Hex(pdf));
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${statement.ref}-statement.pdf"`);
  res.send(pdf);
});

repaymentsRouter.get('/loans/:id/statement.csv', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  const statement = await getStatement(req.user!, req.params.id as string);
  const csv = statementCsv(statement);
  await auditRequest(req, 'statement.generated', 'loan', req.params.id as string, {
    ref: statement.ref,
    format: 'csv',
    sha256: sha256Hex(csv),
  });
  res.type('text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${statement.ref}-statement.csv"`);
  res.send(csv);
});
