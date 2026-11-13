import { sha256Hex } from './crypto';

/**
 * Canonical serialisation helpers.
 *
 * Anything that is hashed and later re-verified (transaction payloads, audit
 * rows, documents) must be serialised deterministically, otherwise a benign
 * JSON key reordering would look like tampering.
 */

/** Recursively sort object keys and stringify with stable ordering. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export interface TransactionHashInput {
  txnId: string;
  loanRef: string;
  type: 'disbursement' | 'repayment';
  amountCents: number;
  occurredAt: Date | string;
  mobileCodeNorm: string | null;
}

/**
 * The exact byte string that is hashed for the on-chain ledger record.
 *
 * Layout (pipe separated, version tagged):
 *   SMF1|<txnId>|<loanRef>|<type>|<amountCents>|<occurredAtEpochSeconds>|<mobileCodeNorm>
 *
 * Only the resulting hash (and the timestamp) is written on-chain, so no
 * personal data or amounts ever leave the database.
 */
export function transactionPayload(input: TransactionHashInput): string {
  const epochSeconds = Math.floor(new Date(input.occurredAt).getTime() / 1000);
  const code = input.mobileCodeNorm ?? '';
  return [
    'SMF1',
    input.txnId,
    input.loanRef,
    input.type,
    String(input.amountCents),
    String(epochSeconds),
    code,
  ].join('|');
}

export function hashTransaction(input: TransactionHashInput): string {
  return sha256Hex(transactionPayload(input));
}

/** Stable bytes32 reference for a loan, derived from its public reference. */
export function hashLoanRef(loanRef: string): string {
  return sha256Hex(`SMF1|loan|${loanRef}`);
}

/** bytes32 (0x + 64 hex) representation used by the Solidity contract. */
export function toBytes32(hashHex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hashHex)) {
    throw new Error(`Expected 32-byte hex hash, received "${hashHex}"`);
  }
  return `0x${hashHex.toLowerCase()}`;
}

export function fromBytes32(value: string): string {
  return value.startsWith('0x') ? value.slice(2).toLowerCase() : value.toLowerCase();
}

/**
 * Audit-chain row hash.
 *
 * row_hash = sha256(canonicalJson([seq, prevHash, actor, action, entity,
 *                                 detailHash, ip, createdAtIso]))
 *
 * Including prev_hash is what makes the log a hash chain: editing or removing
 * any historical row breaks every subsequent hash.
 */
export interface AuditRowHashInput {
  seq: number;
  prevHash: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: Date | string;
}

export function computeAuditRowHash(input: AuditRowHashInput): string {
  const detailHash = sha256Hex(canonicalJson(input.detail ?? {}));
  const createdAt =
    input.createdAt instanceof Date ? input.createdAt.toISOString() : new Date(input.createdAt).toISOString();
  const payload = [
    String(input.seq),
    input.prevHash,
    input.actorUserId ?? '',
    input.actorRole ?? '',
    input.action,
    input.entityType,
    input.entityId ?? '',
    detailHash,
    input.ip ?? '',
    createdAt,
  ];
  return sha256Hex(canonicalJson(payload));
}

/** The genesis link of the audit chain. */
export const GENESIS_HASH = '0'.repeat(64);
