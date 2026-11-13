/**
 * Display formatting helpers. All money is stored as integer minor units
 * (cents) so no floating point maths ever touches an amount.
 */
const kesFormatter = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat('en-KE', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return kesFormatter.format(cents / 100);
}

export function formatMoneyCompact(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `KES ${compactFormatter.format(cents / 100)}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Show a hash as 0x1234…abcd so it fits in a table cell. */
export function shortHash(hash: string | null | undefined, size = 8): string {
  if (!hash) return '—';
  const clean = hash.replace(/^0x/, '');
  if (clean.length <= size * 2) return `0x${clean}`;
  return `0x${clean.slice(0, size)}…${clean.slice(-size)}`;
}

export function percentFromBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
