/**
 * Client-side helpers for the staff login approval flow.
 *
 * After a staff member submits correct credentials, the server returns HTTP 202
 * with a pollToken instead of a session. The browser polls
 * GET /auth/login-requests/:id/status?pollToken=… every few seconds until the
 * auditor approves, denies, or the request expires.
 *
 * Auditor-facing helpers for the approval queue live in the second half.
 */
import { api } from './api';

export interface AwaitingApprovalResponse {
  status: 'awaiting_approval';
  requestId: string;
  pollToken: string;
  expiresAt: string; // ISO
}

export type PollResult =
  | { status: 'pending'; expiresAt: string }
  | { status: 'approved'; user: { id: string; email: string; fullName: string; role: string; createdAt: string }; accessToken: string }
  | { status: 'denied'; reason: string | null }
  | { status: 'expired' }
  | { status: 'used' };

export async function pollApprovalStatus(
  requestId: string,
  pollToken: string,
): Promise<PollResult> {
  return api<PollResult>(
    `/auth/login-requests/${encodeURIComponent(requestId)}/status?pollToken=${encodeURIComponent(pollToken)}`,
  );
}

export async function cancelApprovalRequest(
  requestId: string,
  pollToken: string,
): Promise<void> {
  // There is no cancel endpoint — we just stop polling and let it expire.
  // This is a client-only operation.
  void requestId;
  void pollToken;
}

// ---------------------------------------------------------------------------
// Auditor helpers
// ---------------------------------------------------------------------------

export interface PendingRequest {
  id: string;
  staffUserId: string;
  staffName: string;
  staffEmail: string;
  requestedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ApprovalHistoryRow {
  id: string;
  staff_full_name: string;
  staff_email: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  decided_by_name: string | null;
}

export interface StaffAccount {
  id: string;
  email: string;
  fullName: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export async function fetchPendingRequests(): Promise<PendingRequest[]> {
  const data = await api<{ items: PendingRequest[] }>('/auth/login-requests');
  return data.items;
}

export async function fetchApprovalHistory(): Promise<ApprovalHistoryRow[]> {
  const data = await api<{ items: ApprovalHistoryRow[] }>('/auth/login-requests/history');
  return data.items;
}

export async function fetchStaffAccounts(): Promise<StaffAccount[]> {
  const data = await api<{ items: StaffAccount[] }>('/auth/staff-accounts');
  return data.items;
}

export async function decideRequest(
  id: string,
  decision: 'approve' | 'deny',
  reason?: string,
): Promise<void> {
  await api('/auth/login-requests/' + encodeURIComponent(id) + '/decide', {
    method: 'POST',
    body: { decision, reason },
  });
}

export async function setStaffAccountStatus(
  id: string,
  action: 'approve-account' | 'suspend' | 'reactivate',
): Promise<void> {
  await api('/auth/staff-accounts/' + encodeURIComponent(id) + '/status', {
    method: 'POST',
    body: { action },
  });
}
