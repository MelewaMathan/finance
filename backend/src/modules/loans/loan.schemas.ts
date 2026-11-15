import { z } from 'zod';
import { moneySchema, paginationSchema, uuidSchema } from '../../middleware/validate';

/**
 * Loan input contracts.
 *
 * Note what a borrower cannot set: the interest rate, the totals, or the
 * status. Those are derived by the server, so a crafted request cannot
 * "apply" for a zero-interest loan.
 */
export const applyLoanSchema = z.object({
  lenderId: z.string().uuid('lenderId must be a valid UUID'),
  principalCents: moneySchema.min(10_000, 'minimum loan is KES 100').max(100_000_000, 'maximum loan is KES 1,000,000'),
  termCount: z.coerce.number().int().min(1, 'term must be at least 1 period').max(365, 'term cannot exceed 365 periods'),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  purpose: z.string().trim().min(5, 'describe the purpose (at least 5 characters)').max(240),
  collateralDesc: z.string().trim().max(400).optional(),
  guarantorName: z.string().trim().min(2).max(120).optional(),
  guarantorPhone: z
    .string()
    .trim()
    .regex(/^(\+?254|0)?[17]\d{8}$/, 'enter a Kenyan mobile number')
    .optional(),
  guarantorCredit: z.coerce.number().int().min(0).max(100).optional(),
});

export type ApplyLoanInput = z.infer<typeof applyLoanSchema>;

export const decisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    rateBps: z.coerce.number().int().min(0).max(10_000).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((value) => value.decision !== 'approve' || value.rateBps !== undefined, {
    message: 'rateBps is required when approving',
    path: ['rateBps'],
  });

export type DecisionInput = z.infer<typeof decisionSchema>;

export const disburseSchema = z.object({
  method: z.enum(['cash', 'mobile_money', 'bank']).default('cash'),
  mobileTxnCode: z.string().trim().max(40).optional(),
});

export type DisburseInput = z.infer<typeof disburseSchema>;

export const loanListQuery = paginationSchema.extend({
  status: z
    .enum([
      'pending',
      'under_review',
      'approved',
      'rejected',
      'held',
      'disbursed',
      'active',
      'settled',
      'defaulted',
      'cancelled',
    ])
    .optional(),
  q: z.string().trim().max(80).optional(),
});

export type LoanListQuery = z.infer<typeof loanListQuery>;

export const idParamSchema = z.object({ id: uuidSchema });
