import { ethers } from 'ethers';
import { config } from '../../config/env';
import { AppError } from '../../lib/errors';

/**
 * Ethers.js client for the LoanLedger contract.
 *
 * Only hashes and timestamps are written on-chain. If the chain is disabled
 * (CHAIN_MODE=off or no deployed address) the API still works: records are
 * stored off-chain and marked "not anchored" instead of pretending to be.
 */
export const LEDGER_ABI = [
  'function record(bytes32 loanRef, uint8 txType, uint64 occurredAt, bytes32 recordHash) returns (bytes32)',
  'function verify(bytes32 recordHash) view returns (bool exists, bytes32 loanRef, uint8 txType, uint64 occurredAt, address recorder)',
  'function exists(bytes32 recordHash) view returns (bool)',
  'function recordCount() view returns (uint256)',
  'function anchorAuditRoot(bytes32 root, uint256 uptoSeq) returns (bool)',
  'event Recorded(bytes32 indexed recordHash, bytes32 indexed loanRef, uint8 txType, uint64 occurredAt, address recorder)',
  'event AuditAnchored(bytes32 indexed root, uint256 uptoSeq, address anchoredBy)',
];

export const TX_TYPE = { disbursement: 0, repayment: 1 } as const;

export function chainRpcUrl(): string {
  return config.CHAIN_MODE === 'amoy' ? config.AMOY_RPC_URL || config.CHAIN_RPC_URL : config.CHAIN_RPC_URL;
}

export function isChainEnabled(): boolean {
  return config.CHAIN_MODE !== 'off' && Boolean(config.LEDGER_CONTRACT_ADDRESS);
}

function requireContractAddress(): string {
  if (!isChainEnabled()) {
    throw new AppError(
      503,
      'CHAIN_UNAVAILABLE',
      'Blockchain ledger is not configured. Set LEDGER_CONTRACT_ADDRESS and CHAIN_MODE, or run the deploy script.',
    );
  }
  return config.LEDGER_CONTRACT_ADDRESS as string;
}

function provider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(chainRpcUrl(), config.CHAIN_ID);
}

function signer(): ethers.Wallet {
  if (!config.CHAIN_RECORDER_PRIVATE_KEY) {
    throw new AppError(503, 'CHAIN_UNAVAILABLE', 'CHAIN_RECORDER_PRIVATE_KEY is not configured');
  }
  return new ethers.Wallet(config.CHAIN_RECORDER_PRIVATE_KEY, provider());
}

export function readContract(): ethers.Contract {
  return new ethers.Contract(requireContractAddress(), LEDGER_ABI, provider());
}

export function writeContract(): ethers.Contract {
  return new ethers.Contract(requireContractAddress(), LEDGER_ABI, signer());
}

export interface OnChainRecord {
  loanRef: string;
  txType: number;
  occurredAt: number;
  recorder: string;
  txHash: string;
  blockNumber: number;
}

/** Writes the hash of a disbursement/repayment to the ledger. */
export async function recordOnChain(input: {
  loanRefHash: string;
  txType: 0 | 1;
  occurredAt: Date;
  recordHashHex: string;
}): Promise<OnChainRecord> {
  const contract = writeContract();
  const loanRef = input.loanRefHash.startsWith('0x') ? input.loanRefHash : `0x${input.loanRefHash}`;
  const recordHash = input.recordHashHex.startsWith('0x') ? input.recordHashHex : `0x${input.recordHashHex}`;
  const occurredAt = Math.floor(new Date(input.occurredAt).getTime() / 1000);

  const tx = await contract.record(loanRef, input.txType, occurredAt, recordHash);
  const receipt = await tx.wait();

  return {
    loanRef,
    txType: input.txType,
    occurredAt,
    recorder: await signer().getAddress(),
    txHash: receipt?.hash ?? tx.hash,
    blockNumber: Number(receipt?.blockNumber ?? 0),
  };
}

/** Reads the ledger record for a hash; null when the chain has no such record. */
export async function readOnChain(recordHashHex: string): Promise<Omit<OnChainRecord, 'txHash' | 'blockNumber'> | null> {
  const contract = readContract();
  const recordHash = recordHashHex.startsWith('0x') ? recordHashHex : `0x${recordHashHex}`;
  const result = await contract.verify(recordHash);
  if (!result.exists) return null;
  return {
    loanRef: result.loanRef,
    txType: Number(result.txType),
    occurredAt: Number(result.occurredAt),
    recorder: result.recorder,
  };
}

export async function anchorAuditRoot(rootHash: string, uptoSeq: number): Promise<{ txHash: string; blockNumber: number }> {
  const contract = writeContract();
  const root = rootHash.startsWith('0x') ? rootHash : `0x${rootHash}`;
  const tx = await contract.anchorAuditRoot(root, uptoSeq);
  const receipt = await tx.wait();
  return { txHash: receipt?.hash ?? tx.hash, blockNumber: Number(receipt?.blockNumber ?? 0) };
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

export async function getChainStatus(): Promise<ChainStatus> {
  const status: ChainStatus = {
    mode: config.CHAIN_MODE,
    rpcUrl: chainRpcUrl(),
    chainId: config.CHAIN_ID,
    contractAddress: config.LEDGER_CONTRACT_ADDRESS || null,
    enabled: isChainEnabled(),
    live: false,
  };
  if (!status.enabled) return status;

  try {
    const contract = readContract();
    const [blockNumber, count] = await Promise.all([provider().getBlockNumber(), contract.recordCount()]);
    status.live = true;
    status.latestBlock = blockNumber;
    status.recordCount = Number(count);
  } catch (error) {
    status.error = (error as Error).message?.slice(0, 200);
  }
  return status;
}
