import { config } from '../../config/env';
import { query, queryOne } from '../../db/pool';

/**
 * Advisory credit scoring (M5).
 *
 * The score is *advisory by construction*: nothing in the decision path reads
 * `credit_scores`, and the table carries `advisory_only = true`. A lender may
 * approve a high-risk applicant; the record then shows they saw the warning.
 *
 * Two sources are possible and both are stored honestly:
 *   - ml_service        the Python service answered
 *   - fallback_heuristic the service was down, so a documented formula ran
 * The response never presents the fallback as an ML score.
 */

/** Feature order is a contract with the Python service. */
export const SCORE_FEATURES = [
  'principal_to_income',
  'installment_to_income',
  'term_count',
  'rate_bps',
  'is_daily',
  'prior_loans',
  'prior_settled',
  'prior_defaults',
  'arrears_ratio',
  'active_loans',
  'has_collateral',
  'has_guarantor',
  'guarantor_credit',
  'account_age_days',
] as const;

export type ScoreFeature = (typeof SCORE_FEATURES)[number];
export type ScoreSource = 'ml_service' | 'fallback_heuristic';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ScoreFactor {
  feature: string;
  /** Model-specific magnitude; only the direction is comparable across models. */
  impact: number;
  direction: 'risk' | 'protective';
}

export interface ScoreResult {
  id: string;
  loanId: string;
  score: number;
  riskLevel: RiskLevel;
  defaultProbability: number | null;
  modelVersion: string;
  modelSource: ScoreSource;
  features: Record<string, number>;
  explanation: ScoreFactor[];
  latencyMs: number;
  advisoryOnly: boolean;
  createdAt: string;
}

export const LOW_RISK_MIN = 70;
export const MEDIUM_RISK_MIN = 45;
const FALLBACK_VERSION = 'fallback-heuristic-v1';

interface ScoringLoan {
  id: string;
  borrower_id: string;
  principal_cents: number;
  term_count: number;
  frequency: string;
  rate_bps: number;
  total_repayable_cents: number;
  collateral_desc: string | null;
  guarantor_credit: number | null;
  guarantor_name_enc: string | null;
  created_at: Date;
}

interface ScoreRow {
  id: string;
  loan_id: string;
  score: number;
  risk_level: RiskLevel;
  model_version: string;
  model_source: ScoreSource;
  features: Record<string, number>;
  explanation: ScoreFactor[];
  latency_ms: number | null;
  advisory_only: boolean;
  created_at: Date;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Builds the feature vector. Every value comes from our own tables; nothing
 * personally identifying is included, so the ML service can be run in a
 * separate trust domain.
 */
export async function buildFeatures(loan: ScoringLoan): Promise<Record<ScoreFeature, number>> {
  const profile = await queryOne<{ monthly_income_cents: number | null }>(
    'SELECT monthly_income_cents FROM borrower_profiles WHERE user_id = $1',
    [loan.borrower_id],
  );
  const account = await queryOne<{ age_days: number }>(
    'SELECT GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - created_at)) / 86400))::int AS age_days FROM users WHERE id = $1',
    [loan.borrower_id],
  );

  const history = await queryOne<{
    prior_loans: number;
    prior_settled: number;
    prior_defaults: number;
    active_loans: number;
  }>(
    `SELECT count(*)::int AS prior_loans,
            count(*) FILTER (WHERE status = 'settled')::int AS prior_settled,
            count(*) FILTER (WHERE status = 'defaulted')::int AS prior_defaults,
            count(*) FILTER (WHERE status IN ('disbursed', 'active'))::int AS active_loans
       FROM loans
      WHERE borrower_id = $1 AND id <> $2`,
    [loan.borrower_id, loan.id],
  );

  const arrears = await queryOne<{ total: number; late: number }>(
    `SELECT count(i.id)::int AS total,
            count(i.id) FILTER (WHERE i.status = 'overdue' OR i.penalty_accrued_cents > 0)::int AS late
       FROM loan_installments i
       JOIN loans l ON l.id = i.loan_id
      WHERE l.borrower_id = $1 AND l.id <> $2`,
    [loan.borrower_id, loan.id],
  );

  const incomeCents = Number(profile?.monthly_income_cents ?? 0);
  const income = incomeCents > 0 ? incomeCents : loan.principal_cents;
  const installmentCents = loan.total_repayable_cents / Math.max(1, loan.term_count);
  const totalInstallments = Number(arrears?.total ?? 0);

  return {
    principal_to_income: clamp(loan.principal_cents / income, 0, 20),
    installment_to_income: clamp(installmentCents / income, 0, 5),
    term_count: clamp(loan.term_count, 1, 365),
    rate_bps: clamp(loan.rate_bps, 0, 10_000),
    is_daily: loan.frequency === 'daily' ? 1 : 0,
    prior_loans: clamp(Number(history?.prior_loans ?? 0), 0, 200),
    prior_settled: clamp(Number(history?.prior_settled ?? 0), 0, 200),
    prior_defaults: clamp(Number(history?.prior_defaults ?? 0), 0, 200),
    arrears_ratio: totalInstallments === 0 ? 0 : clamp(Number(arrears?.late ?? 0) / totalInstallments, 0, 1),
    active_loans: clamp(Number(history?.active_loans ?? 0), 0, 50),
    has_collateral: loan.collateral_desc ? 1 : 0,
    has_guarantor: loan.guarantor_name_enc ? 1 : 0,
    guarantor_credit: loan.guarantor_credit === null ? -1 : clamp(loan.guarantor_credit, 0, 100),
    account_age_days: clamp(Number(account?.age_days ?? 0), 0, 3650),
  };
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Deterministic fallback used when the Python service cannot be reached.
 *
 * It is the same latent model the trainer uses to generate labels, with the
 * same weights, so the fallback cannot disagree wildly with the trained model.
 * It is still labelled `fallback_heuristic` everywhere: calling a hand-set
 * formula a machine-learning score would be a lie the audit trail should not
 * tell.
 */
export function heuristicProbability(features: Record<ScoreFeature, number>): number {
  const signal =
    (1.35 * clamp(features.principal_to_income, 0, 6)) / 2 +
    2.3 * clamp(features.installment_to_income, 0, 2) +
    (0.55 * clamp(features.term_count - 12, 0, 60)) / 24 +
    0.35 * features.is_daily +
    0.28 * (features.rate_bps / 10_000) * 10 -
    (0.35 * clamp(features.prior_settled, 0, 5)) / 5 +
    0.85 * clamp(features.prior_defaults, 0, 3) +
    2.1 * features.arrears_ratio +
    0.45 * clamp(features.active_loans, 0, 3) -
    0.45 * features.has_collateral -
    0.4 * features.has_guarantor -
    (0.3 * clamp(features.guarantor_credit, 0, 100)) / 100 -
    (0.35 * clamp(features.account_age_days, 0, 730)) / 730;
  return sigmoid(-3.45 + 1.9 * signal);
}

/** Logit-space contributions, which is what the fallback can honestly explain. */
function heuristicFactors(features: Record<ScoreFeature, number>): ScoreFactor[] {
  const terms: Array<[ScoreFeature, number]> = [
    ['principal_to_income', (1.35 * clamp(features.principal_to_income, 0, 6)) / 2],
    ['installment_to_income', 2.3 * clamp(features.installment_to_income, 0, 2)],
    ['term_count', (0.55 * clamp(features.term_count - 12, 0, 60)) / 24],
    ['is_daily', 0.35 * features.is_daily],
    ['rate_bps', 0.28 * (features.rate_bps / 10_000) * 10],
    ['prior_settled', (-0.35 * clamp(features.prior_settled, 0, 5)) / 5],
    ['prior_defaults', 0.85 * clamp(features.prior_defaults, 0, 3)],
    ['arrears_ratio', 2.1 * features.arrears_ratio],
    ['active_loans', 0.45 * clamp(features.active_loans, 0, 3)],
    ['has_collateral', -0.45 * features.has_collateral],
    ['has_guarantor', -0.4 * features.has_guarantor],
    ['guarantor_credit', (-0.3 * clamp(features.guarantor_credit, 0, 100)) / 100],
    ['account_age_days', (-0.35 * clamp(features.account_age_days, 0, 730)) / 730],
  ];
  return terms
    .map(([feature, weight]) => ({
      feature,
      impact: Number(weight.toFixed(4)),
      direction: weight > 0 ? ('risk' as const) : ('protective' as const),
    }))
    .filter((factor) => Math.abs(factor.impact) >= 0.02)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 6);
}

interface MlScoreResponse {
  score: number;
  risk_level: RiskLevel;
  default_probability: number;
  model_version: string;
  explanation: ScoreFactor[];
}

async function callMlService(features: Record<ScoreFeature, number>): Promise<MlScoreResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ML_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.ML_SERVICE_URL}/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Features only. The loan id is deliberately left out: the scoring
      // service needs numbers, and anything that identifies a borrower must not
      // cross this boundary (see docs/DFD.md, boundary B4).
      body: JSON.stringify({ features }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[scoring] ml service returned ${response.status}`);
      return null;
    }
    return (await response.json()) as MlScoreResponse;
  } catch (error) {
    console.warn(`[scoring] ml service unreachable: ${(error as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toResult(row: ScoreRow): ScoreResult {
  return {
    id: row.id,
    loanId: row.loan_id,
    score: row.score,
    riskLevel: row.risk_level,
    defaultProbability:
      typeof row.features?.default_probability === 'number' ? row.features.default_probability : null,
    modelVersion: row.model_version,
    modelSource: row.model_source,
    features: row.features,
    explanation: row.explanation ?? [],
    latencyMs: row.latency_ms ?? 0,
    advisoryOnly: row.advisory_only,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SCORE_SELECT = `
  SELECT id, loan_id, score, risk_level, model_version, model_source, features, explanation,
         latency_ms, advisory_only, created_at
    FROM credit_scores
`;

/**
 * Scores a loan and stores the snapshot. Never throws when the ML service is
 * down: the fallback runs instead, because a scoring outage must not stop a
 * lender from working.
 */
export async function generateScore(loanId: string): Promise<ScoreResult> {
  const loan = await queryOne<ScoringLoan>(
    `SELECT id, borrower_id, principal_cents, term_count, frequency, rate_bps,
            total_repayable_cents, collateral_desc, guarantor_credit, guarantor_name_enc, created_at
       FROM loans WHERE id = $1`,
    [loanId],
  );
  if (!loan) throw new Error(`Loan ${loanId} not found while scoring`);

  const features = await buildFeatures(loan);
  const started = Date.now();

  let source: ScoreSource = 'fallback_heuristic';
  let modelVersion = FALLBACK_VERSION;
  let score: number;
  let riskLevel: RiskLevel;
  let probability: number;
  let explanation: ScoreFactor[];

  const remote = config.ML_FORCE_FALLBACK ? null : await callMlService(features);
  if (remote) {
    source = 'ml_service';
    modelVersion = remote.model_version;
    score = clamp(Math.round(remote.score), 0, 100);
    riskLevel = remote.risk_level;
    probability = remote.default_probability;
    explanation = remote.explanation ?? [];
  } else {
    probability = heuristicProbability(features);
    score = Math.round((1 - probability) * 100);
    riskLevel = score >= LOW_RISK_MIN ? 'low' : score >= MEDIUM_RISK_MIN ? 'medium' : 'high';
    explanation = heuristicFactors(features);
  }
  // The default probability is kept with the snapshot so the audit trail can
  // show what the model believed, not just the bucket it landed in.
  const storedFeatures = { ...features, default_probability: Number(probability.toFixed(4)) };
  const latencyMs = Date.now() - started;

  const row = await queryOne<ScoreRow>(
    `INSERT INTO credit_scores
       (loan_id, model_version, model_source, score, risk_level, features, explanation, advisory_only, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
     RETURNING id, loan_id, score, risk_level, model_version, model_source, features, explanation,
               latency_ms, advisory_only, created_at`,
    [loanId, modelVersion, source, score, riskLevel, JSON.stringify(storedFeatures), JSON.stringify(explanation), latencyMs],
  );
  if (!row) throw new Error('credit_scores insert returned no row');

  await query('UPDATE loans SET score_snapshot_id = $2 WHERE id = $1', [loanId, row.id]);
  return toResult(row);
}

/** Latest stored score for a loan, or null when it was never scored. */
export async function getLatestScore(loanId: string): Promise<ScoreResult | null> {
  const row = await queryOne<ScoreRow>(`${SCORE_SELECT} WHERE loan_id = $1 ORDER BY created_at DESC LIMIT 1`, [
    loanId,
  ]);
  return row ? toResult(row) : null;
}

export function riskTone(level: RiskLevel): 'success' | 'warning' | 'danger' {
  return level === 'low' ? 'success' : level === 'medium' ? 'warning' : 'danger';
}
