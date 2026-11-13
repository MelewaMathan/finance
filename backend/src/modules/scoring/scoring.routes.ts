import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditRequest } from '../audit/audit.service';
import { idParamSchema } from '../loans/loan.schemas';
import { loadVisibleLoan } from '../loans/loan.service';
import { generateScore, getLatestScore } from './scoring.service';

/**
 * Credit-score routes.
 *
 * Reading is open to anyone who may see the loan (borrower, lender, auditor):
 * a borrower is entitled to know what the model said about them. Re-running
 * the score is the lender's call, and every run is audited with its source.
 */
export const scoringRouter = Router();

scoringRouter.get('/loans/:id/score', requireAuth, validate(idParamSchema, 'params'), async (req, res) => {
  const loan = await loadVisibleLoan(req.user!, req.params.id as string);
  const score = await getLatestScore(loan.id);
  res.json({ score, model: score ? { version: score.modelVersion, source: score.modelSource } : null });
});

scoringRouter.post(
  '/loans/:id/score',
  requireAuth,
  requireRole('lender'),
  validate(idParamSchema, 'params'),
  async (req, res) => {
    const loan = await loadVisibleLoan(req.user!, req.params.id as string);
    const score = await generateScore(loan.id);
    await auditRequest(req, 'credit_score.generated', 'loan', loan.id, {
      ref: loan.ref,
      score: score.score,
      riskLevel: score.riskLevel,
      source: score.modelSource,
      modelVersion: score.modelVersion,
      advisoryOnly: true,
    });
    res.json({ score });
  },
);
