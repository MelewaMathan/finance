import { z } from 'zod';

/** Review-queue filters. `status=all` is what the forensic view asks for. */
export const flagQuerySchema = z.object({
  status: z.enum(['open', 'cleared', 'confirmed', 'all']).default('open'),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  loanId: z.string().uuid('must be a valid id').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * A resolution is a judgement, so a note is mandatory. "Cleared" without a
 * reason is indistinguishable from a rubber stamp six months later.
 */
export const resolveFlagSchema = z.object({
  resolution: z.enum(['cleared', 'confirmed']),
  note: z.string().trim().min(5, 'explain the decision').max(500),
});

/**
 * Releasing a hold moves real money, so it is a separate, explicitly named
 * action rather than a side effect of clearing a flag.
 */
export const holdDecisionSchema = z.object({
  decision: z.enum(['release', 'reject']),
  note: z.string().trim().min(5, 'explain the decision').max(500),
});

export type FlagQuery = z.infer<typeof flagQuerySchema>;
export type ResolveFlagInput = z.infer<typeof resolveFlagSchema>;
export type HoldDecisionInput = z.infer<typeof holdDecisionSchema>;

/** Alert inbox filter: the badge counts unread, the list can show everything. */
export const alertQuerySchema = z.object({
  unread: z.enum(['true', 'false']).default('false'),
});

export type AlertQuery = z.infer<typeof alertQuerySchema>;
