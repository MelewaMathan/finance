import type { PoolClient } from 'pg';
import { config } from '../../config/env';
import { query } from '../../db/pool';

/**
 * Penalty accrual for overdue installments.
 *
 * The penalty is recomputed from the due date every time it is read, and
 * stored with GREATEST(old, new) so it only ever grows. That makes the
 * operation idempotent: reading the loan twice does not double the charge,
 * and a missing nightly job cannot leave a loan quietly penalty-free.
 *
 * Rate: PENALTY_RATE_BPS per month, pro rata per day, after the grace period.
 */
const ACCRUAL_SQL = `
  UPDATE loan_installments
     SET penalty_accrued_cents = GREATEST(
           penalty_accrued_cents,
           ROUND(
             (principal_due_cents + interest_due_cents - paid_principal_cents - paid_interest_cents)
             * ($2::numeric / 10000)
             * GREATEST(0, (CURRENT_DATE - due_date) - $3::int)
             / 30
           )::bigint
         ),
         status = CASE
           WHEN status = 'pending' AND due_date < CURRENT_DATE THEN 'overdue'
           ELSE status
         END
   WHERE loan_id = $1
     AND status IN ('pending', 'partial', 'overdue')
     AND due_date < CURRENT_DATE - $3::int
`;

export async function accruePenalties(loanId: string, client?: PoolClient): Promise<void> {
  const params = [loanId, config.PENALTY_RATE_BPS, config.PENALTY_GRACE_DAYS];
  if (client) {
    await client.query(ACCRUAL_SQL, params);
    return;
  }
  await query(ACCRUAL_SQL, params);
}
