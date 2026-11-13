import { Router } from 'express';
import { sha256Hex } from '../../lib/crypto';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  auditExportSchema,
  auditQuerySchema,
  integrityCheckSchema,
  integrityHistorySchema,
  timelineQuerySchema,
  type AuditExportQuery,
  type IntegrityCheckInput,
} from './audit.schemas';
import {
  auditActions,
  auditCsv,
  auditPdf,
  listIntegrityChecks,
  loanTimeline,
  runIntegrityCheck,
  searchAudit,
  type AuditFilters,
} from './forensic.service';

/**
 * Forensic dashboard routes (M7).
 *
 * Everything here is auditor-only, including the reads. That is deliberate:
 * the audit log contains other users' IP addresses and request ids, and a
 * lender who could read it could also learn which of their transactions the
 * review queue is watching.
 */
export const auditRouter = Router();

auditRouter.use('/audit', requireAuth, requireRole('auditor'));
auditRouter.use('/integrity', requireAuth, requireRole('auditor'));

const asFilters = (query: AuditExportQuery): AuditFilters => ({
  q: query.q,
  action: query.action,
  entityType: query.entityType,
  entityId: query.entityId,
  actorId: query.actorId,
  from: query.from,
  to: query.to,
});

auditRouter.get('/audit/logs', validate(auditQuerySchema, 'query'), async (req, res) => {
  const query = req.query as unknown as Parameters<typeof searchAudit>[1] & {
    page: number;
    pageSize: number;
  };
  res.json(await searchAudit(req.user!, asFilters(query), query.page, query.pageSize));
});

auditRouter.get('/audit/actions', async (req, res) => {
  const actions = await auditActions(req.user!);
  res.json({ actions });
});

auditRouter.get('/audit/timeline', validate(timelineQuerySchema, 'query'), async (req, res) => {
  const { loanId, ref } = req.query as unknown as { loanId?: string; ref?: string };
  res.json(await loanTimeline(req.user!, { loanId, ref }));
});

auditRouter.get('/audit/export.csv', validate(auditExportSchema, 'query'), async (req, res) => {
  const filters = asFilters(req.query as unknown as AuditExportQuery);
  const csv = await auditCsv(req.user!, filters, req);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('X-Document-SHA256', sha256Hex(csv));
  res.type('text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`);
  res.send(csv);
});

auditRouter.get('/audit/export.pdf', validate(auditExportSchema, 'query'), async (req, res) => {
  const filters = asFilters(req.query as unknown as AuditExportQuery);
  const pdf = await auditPdf(req.user!, filters, req);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('X-Document-SHA256', sha256Hex(pdf));
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${stamp}.pdf"`);
  res.send(pdf);
});

auditRouter.post('/integrity/check', validate(integrityCheckSchema, 'body'), async (req, res) => {
  const input = req.body as IntegrityCheckInput;
  const run = await runIntegrityCheck(req.user!, input.scope, { targetId: input.targetId, ref: input.ref }, req);
  // A tampered result is a finding, not a server failure: 200 with the verdict.
  res.json({ check: run });
});

auditRouter.get('/integrity/checks', validate(integrityHistorySchema, 'query'), async (req, res) => {
  const { limit } = req.query as unknown as { limit: number };
  const checks = await listIntegrityChecks(req.user!, limit);
  res.json({ checks, count: checks.length });
});
