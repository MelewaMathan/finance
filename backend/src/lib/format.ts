/**
 * Formatting used inside generated documents.
 *
 * The API never sends pre-formatted strings (clients format their own money);
 * this exists only for PDF/CSV content, which must be human readable on paper.
 */
export function formatMoneyForDocument(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `KES ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
