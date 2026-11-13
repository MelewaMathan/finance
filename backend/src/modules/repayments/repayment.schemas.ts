import { z } from 'zod';
import { moneySchema } from '../../middleware/validate';

/** Repayment input contract. */
export const repaymentSchema = z.object({
  amountCents: moneySchema,
  method: z.enum(['cash', 'mobile_money', 'bank']).default('mobile_money'),
  mobileTxnCode: z.string().trim().max(40).optional(),
  occurredAt: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO timestamp')
    .optional(),
  note: z.string().trim().max(300).optional(),
});

export type RepaymentInput = z.infer<typeof repaymentSchema>;
