import { z } from 'zod';

/**
 * Forensic query schemas (M7).
 *
 * Dates arrive from a browser date picker as `YYYY-MM-DD` and from an API
 * client as a full timestamp, so both are accepted; the service widens a
 * date-only `to` to the end of that day so "to 31 Nov" includes 31 Nov.
 */
const dateish = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}([T ].*)?$/, 'use YYYY-MM-DD or an ISO timestamp');

/** Filters shared by the log view and both exports, so they cannot drift. */
const auditFilters = z.object({
  q: z.string().trim().max(120).optional(),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(80).optional(),
  actorId: z.string().uuid('must be a valid id').optional(),
  from: dateish.optional(),
  to: dateish.optional(),
});

/** Day-granularity comparison: "12 Nov 09:00" is not after "12 Nov". */
const orderedDays = (value: { from?: string; to?: string }) =>
  !value.from || !value.to || value.from.slice(0, 10) <= value.to.slice(0, 10);

const orderIssue = { message: 'from must not be after to', path: ['from'] };

export const auditQuerySchema = auditFilters
  .extend({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine(orderedDays, orderIssue);

/** Exports reuse the same filters; paging is meaningless for a file. */
export const auditExportSchema = auditFilters.refine(orderedDays, orderIssue);

export const timelineQuerySchema = z
  .object({
    loanId: z.string().uuid('must be a valid loan id').optional(),
    ref: z.string().trim().min(3).max(40).optional(),
  })
  .refine((value) => Boolean(value.loanId || value.ref), {
    message: 'provide loanId or ref',
    path: ['loanId'],
  });

/**
 * `audit_chain` is cheap and can be run often. `all` re-derives every loan's
 * ledger report, so it is an explicit, auditable act rather than a page load.
 */
export const integrityCheckSchema = z
  .object({
    scope: z.enum(['all', 'audit_chain', 'loan']),
    targetId: z.string().uuid('must be a valid loan id').optional(),
    ref: z.string().trim().min(3).max(40).optional(),
  })
  .refine((value) => value.scope !== 'loan' || Boolean(value.targetId || value.ref), {
    message: 'a loan id or reference is required for a loan-scoped check',
    path: ['targetId'],
  });

export const integrityHistorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type AuditExportQuery = z.infer<typeof auditExportSchema>;
export type IntegrityCheckInput = z.infer<typeof integrityCheckSchema>;
