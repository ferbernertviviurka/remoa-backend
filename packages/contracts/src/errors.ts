import { z } from 'zod';
import { errorCodes } from './constants';

export { errorCodes }; // CCR-058: zod-free in ./constants
export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const appErrorSchema = z.object({ code: errorCodeSchema, message: z.string() });
export type AppError = z.infer<typeof appErrorSchema>;

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = <T = never>(code: ErrorCode, message: string): Result<T> => ({
  ok: false,
  error: { code, message },
});

/** HTTP error body: `{ error: { code, message } }`. */
export const httpErrorBodySchema = z.object({ error: appErrorSchema });
export type HttpErrorBody = z.infer<typeof httpErrorBodySchema>;

export const errorHttpStatus: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation: 422,
  quota_exceeded: 402,
  rate_limited: 429,
  conflict: 409,
  ai_unavailable: 503,
  internal: 500,
};

/** zod parse as a Result (`validation` error with joined issue paths). */
export const parseWith = <S extends z.ZodTypeAny>(schema: S, input: unknown): Result<z.output<S>> => {
  const r = schema.safeParse(input);
  return r.success
    ? ok(r.data)
    : err('validation', r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
};
