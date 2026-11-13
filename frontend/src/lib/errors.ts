import { ApiError } from './api';

/** Turns a validation error payload into { field: message } for inline hints. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const details = error.details;
  if (!Array.isArray(details)) return {};
  const result: Record<string, string> = {};
  for (const item of details) {
    if (item && typeof item === 'object' && 'path' in item && 'message' in item) {
      const path = String((item as { path: unknown }).path ?? '');
      const message = String((item as { message: unknown }).message ?? '');
      if (path) result[path.split('.').pop() ?? path] = message;
    }
  }
  return result;
}

/** Safe, user-facing message for any thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}
