import { config } from '../../config/env';
import { query, queryOne } from '../../db/pool';
import { alertStaff, raiseFlag, type FlagDraft } from './rules.engine';

/**
 * Anomaly detection (fraud layer 2).
 *
 * Layer 1 in rules.engine.ts looks for things we can name. This layer asks an
 * Isolation Forest -- trained on normal behaviour only -- whether a money
 * movement sits far away from how people normally move money: an unusual
 * amount, at an unusual hour, from someone with no history of either.
 *
 * Design decisions that matter for the audit trail:
 *   - We send seven numbers and nothing else. No name, no phone, no receipt
 *     code: the ML service is a separate trust domain and must stay blind.
 *   - The service returns a decision score; we store the risk on the
 *     transaction (`transactions.fraud_score`) so a reviewer can see what the
 *     model thought at the time, not just that a flag exists.
 *   - The layer fails *open*. Rules fail closed. If the model is unreachable
 *     the payment is still checked against every deterministic rule; holding
 *     money because a Python process is down would be its own outage.
 */

/** Feature order is a contract with ml-service/app/anomaly.py. */
export const ANOMALY_FEATURES = [
  'log_amount',
  'amount_ratio',
  'hour_of_day',
  'txns_24h',
  'distinct_codes_24h',
  'days_since_previous',
  'loan_paid_ratio',
] as const;

export type AnomalyFeature = (typeof ANOMALY_FEATURES)[number];
export type AnomalyFeatures = Record<AnomalyFeature, number>;
export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface UnusualFeature {
  feature: string;
  value: number;
  /** Median of the training population, in the same units. */
  typical: number;
  /** Robust z-score (MAD based), not a standard deviation. */
  deviation: number;
}

export interface AnomalyResponse {
  is_anomaly: boolean;
  risk: number;
  severity: AnomalySeverity;
  decision_score: number;
  threshold: number;
  model_version: string;
  latency_ms: number;
  unusual: UnusualFeature[];
}

export interface AnomalyInput {
  loanId: string;
  transactionId: string;
  borrowerId: string;
  amountCents: number;
  occurredAt: Date;
}

export interface AnomalyVerdict {
  /** Null when the model was unreachable; the movement proceeds on rules alone. */
  result: AnomalyResponse | null;
  features: AnomalyFeatures | null;
  drafts: FlagDraft[];
}

/** Swappable so tests can exercise the hold path without a live Python service. */
export type AnomalyScorer = (features: AnomalyFeatures) => Promise<AnomalyResponse | null>;

const MAX_FEATURE = {
  log_amount: [0, 20],
  amount_ratio: [0, 50],
  hour_of_day: [0, 23],
  txns_24h: [0, 100],
  distinct_codes_24h: [0, 100],
  days_since_previous: [0, 365],
  loan_paid_ratio: [0, 1],
} as const satisfies Record<AnomalyFeature, readonly [number, number]>;

function clampFeature(name: AnomalyFeature, value: number): number {
  const [min, max] = MAX_FEATURE[name];
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Kenya is UTC+3 all year, so the hour is computed explicitly instead of
 * trusting the host's timezone: a server in UTC would otherwise report a
 * 03:00 payment as 00:00 and mis-grade the very signal we care about.
 */
export function nairobiHour(at: Date): number {
  return new Date(at.getTime() + 3 * 60 * 60 * 1000).getUTCHours();
}

/**
 * Builds the seven features from our own tables.
 *
 * `amount_ratio` is the interesting one: KES 60,000 is unremarkable for a
 * borrower who always pays KES 50,000 and alarming for one who pays KES 500.
 */
export async function buildAnomalyFeatures(input: AnomalyInput): Promise<AnomalyFeatures> {
  const [history, window, previous, repaid] = await Promise.all([
    queryOne<{ median_cents: number | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t.amount_cents)::float8 AS median_cents
         FROM transactions t
         JOIN loans l ON l.id = t.loan_id
        WHERE l.borrower_id = $1 AND t.id <> $2 AND t.status <> 'rejected'`,
      [input.borrowerId, input.transactionId],
    ),
    queryOne<{ txns: number; codes: number }>(
      `SELECT count(*)::int AS txns,
              count(DISTINCT t.mobile_txn_code_norm)::int AS codes
         FROM transactions t
         JOIN loans l ON l.id = t.loan_id
        WHERE l.borrower_id = $1
          AND t.id <> $2
          AND t.status <> 'rejected'
          AND t.occurred_at <= $3::timestamptz
          AND t.occurred_at > $3::timestamptz - interval '24 hours'`,
      [input.borrowerId, input.transactionId, input.occurredAt],
    ),
    queryOne<{ days: number | null }>(
      `SELECT EXTRACT(EPOCH FROM ($3::timestamptz - max(t.occurred_at))) / 86400.0 AS days
         FROM transactions t
         JOIN loans l ON l.id = t.loan_id
        WHERE l.borrower_id = $1
          AND t.id <> $2
          AND t.status <> 'rejected'
          AND t.occurred_at < $3::timestamptz`,
      [input.borrowerId, input.transactionId, input.occurredAt],
    ),
    queryOne<{ paid: number; due: number }>(
      `SELECT COALESCE(SUM(paid_principal_cents + paid_interest_cents + paid_penalty_cents), 0)::bigint AS paid,
              COALESCE(SUM(principal_due_cents + interest_due_cents + penalty_accrued_cents), 0)::bigint AS due
         FROM loan_installments WHERE loan_id = $1`,
      [input.loanId],
    ),
  ]);

  const amountKes = input.amountCents / 100;
  const median = Number(history?.median_cents ?? 0);
  const paid = Number(repaid?.paid ?? 0);
  const due = Number(repaid?.due ?? 0);

  return {
    log_amount: clampFeature('log_amount', Math.log1p(amountKes)),
    // No history means no baseline; the ratio is then 1 by definition rather
    // than infinite, so a first-time borrower is judged on their other signals.
    amount_ratio: clampFeature('amount_ratio', median > 0 ? amountKes / (median / 100) : 1),
    hour_of_day: clampFeature('hour_of_day', nairobiHour(input.occurredAt)),
    txns_24h: clampFeature('txns_24h', Number(window?.txns ?? 0)),
    distinct_codes_24h: clampFeature('distinct_codes_24h', Number(window?.codes ?? 0)),
    days_since_previous: clampFeature('days_since_previous', previous?.days === null || previous?.days === undefined ? 365 : Number(previous.days)),
    loan_paid_ratio: clampFeature('loan_paid_ratio', due > 0 ? paid / due : 0),
  };
}

async function callMlService(features: AnomalyFeatures): Promise<AnomalyResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ML_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.ML_SERVICE_URL}/anomaly`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[fraud] anomaly service returned ${response.status}`);
      return null;
    }
    return (await response.json()) as AnomalyResponse;
  } catch (error) {
    console.warn(`[fraud] anomaly service unreachable: ${(error as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * In tests and offline demos `ML_FORCE_FALLBACK` keeps the process from
 * reaching out at all: an unreachable-bedrock dependency must not make the
 * suite slow, and a canned verdict is more honest than a flaky one.
 */
const defaultScorer: AnomalyScorer = async (features) => (config.ML_FORCE_FALLBACK ? null : callMlService(features));

let activeScorer: AnomalyScorer = defaultScorer;

/**
 * Test seam. A suite needs to prove the *hold* path -- that a flagged movement
 * is parked and a reviewer can release it -- without standing up scikit-learn
 * on every machine that runs the tests. Production cannot call this.
 */
export function __setAnomalyScorer(scorer: AnomalyScorer | null): void {
  if (config.NODE_ENV !== 'test') throw new Error('__setAnomalyScorer is only available in tests');
  activeScorer = scorer ?? defaultScorer;
}

/** Human wording used in hold reasons and alerts. */
export function describeAnomaly(result: AnomalyResponse): string {
  const [top] = result.unusual;
  if (!top) return `unusual movement pattern (risk ${(result.risk * 100).toFixed(0)}%)`;
  return `${top.feature.replace(/_/g, ' ')} far from normal (risk ${(result.risk * 100).toFixed(0)}%)`;
}

/**
 * Asks the model about one money movement and, if it is unusual, records a
 * flag. Returns the drafts that were newly created so the caller can decide
 * whether the movement should be held.
 */
export async function detectAnomaly(
  input: AnomalyInput,
  scorer: AnomalyScorer = activeScorer,
): Promise<AnomalyVerdict> {
  const features = await buildAnomalyFeatures(input);
  const result = await scorer(features);
  if (!result) return { result: null, features, drafts: [] };

  // Keep the model's own number next to the movement it judged.
  await query('UPDATE transactions SET fraud_score = $2 WHERE id = $1', [
    input.transactionId,
    Math.min(1, Math.max(0, result.risk)),
  ]);

  if (!result.is_anomaly) return { result, features, drafts: [] };

  const draft: FlagDraft = {
    flagType: 'ml_anomaly',
    severity: result.severity,
    source: 'ml',
    ruleId: 'ML2_isolation_forest',
    loanId: input.loanId,
    transactionId: input.transactionId,
    borrowerId: input.borrowerId,
    detail: {
      modelVersion: result.model_version,
      risk: Number(result.risk.toFixed(4)),
      decisionScore: Number(result.decision_score.toFixed(4)),
      threshold: Number(result.threshold.toFixed(4)),
      features,
      unusual: result.unusual,
    },
    dedupeKey: `ml_anomaly:${input.transactionId}`,
  };

  const raised = await raiseFlag(draft);
  if (!raised.created) return { result, features, drafts: [] };

  if (draft.severity === 'high' || draft.severity === 'critical') {
    await alertStaff(
      input.loanId,
      'Unusual transaction pattern',
      `${describeAnomaly(result)}. The movement is held until you review it.`,
      draft.severity,
    );
  }

  return { result, features, drafts: [draft] };
}
