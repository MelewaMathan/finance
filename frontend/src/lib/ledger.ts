import { api } from './api';

/** Typed access to the ledger endpoints (M4). */

export type ProofState = 'verified' | 'anchored_unchecked' | 'unanchored' | 'broken';

export interface PaymentProof {
  transactionId: string;
  type: 'disbursement' | 'repayment';
  method: string;
  amountCents: number;
  occurredAt: string;
  transactionStatus: string;
  recomputedHash: string;
  recordedHash: string | null;
  onChain: {
    hash: string;
    txHash: string | null;
    block: number | null;
    recorder: string | null;
    recordedAt: string | null;
  } | null;
  state: ProofState;
  problem: string | null;
}

export interface ChainStatus {
  mode: string;
  rpcUrl: string;
  chainId: number;
  contractAddress: string | null;
  enabled: boolean;
  live: boolean;
  latestBlock?: number;
  recordCount?: number;
  error?: string;
}

export interface LoanProofReport {
  loan: { id: string; ref: string; status: string };
  loanRefHash: string;
  chain: ChainStatus;
  proofs: PaymentProof[];
  summary: { total: number; verified: number; anchoredUnchecked: number; unanchored: number; broken: number };
  ok: boolean;
  generatedAt: string;
}

export const PROOF_LABEL: Record<ProofState, string> = {
  verified: 'Verified on-chain',
  anchored_unchecked: 'Anchored, ledger unreachable',
  unanchored: 'Not anchored yet',
  broken: 'Integrity failure',
};

export const PROOF_TONE: Record<ProofState, 'success' | 'warning' | 'neutral' | 'danger'> = {
  verified: 'success',
  anchored_unchecked: 'warning',
  unanchored: 'neutral',
  broken: 'danger',
};

export async function getChainStatus(): Promise<ChainStatus> {
  const response = await api<{ chain: ChainStatus }>('/ledger/status');
  return response.chain;
}

export async function getLoanProof(loanId: string): Promise<LoanProofReport> {
  const response = await api<{ report: LoanProofReport }>(`/loans/${loanId}/proof`);
  return response.report;
}

export async function anchorLoanTransactions(
  loanId: string,
): Promise<{ attempted: number; anchored: number; skipped: number; failures: Array<{ transactionId: string; reason: string }> }> {
  const response = await api<{
    result: { attempted: number; anchored: number; skipped: number; failures: Array<{ transactionId: string; reason: string }> };
  }>(`/loans/${loanId}/anchor`, { method: 'POST', body: {} });
  return response.result;
}
