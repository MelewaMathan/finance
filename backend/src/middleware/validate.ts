import type { NextFunction, Request, Response } from 'express';
import { z, type ZodType } from 'zod';

type Source = 'body' | 'query' | 'params';

/**
 * Validates and *replaces* the request source with the parsed value, so the
 * controller only ever sees typed, coerced, allow-listed data. Unknown keys
 * are stripped by zod's default object behaviour (mass-assignment defence).
 */
export function validate<T extends ZodType>(schema: T, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(result.error);
      return;
    }
    // Express 5 makes req.query a getter; assign via defineProperty-safe path.
    if (source === 'query') {
      Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
    } else {
      (req as unknown as Record<string, unknown>)[source] = result.data;
    }
    next();
  };
}

/** Shared primitives so validation reads the same everywhere. */
export const uuidSchema = z.string().uuid('must be a valid id');
export const moneySchema = z
  .number()
  .int('amount must be a whole number of cents')
  .positive('amount must be greater than zero')
  .max(1_000_000_000, 'amount is implausibly large');
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;
