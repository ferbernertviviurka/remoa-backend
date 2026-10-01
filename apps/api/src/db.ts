import { ok, type AppError, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';

// Lazy: importing @remoa/db throws without DATABASE_URL, and app.test.ts must load the app without a database.
export const dbm = () => import('@remoa/db');
export const run = async <T>(userId: string, fn: (tx: Tx, s: typeof import('@remoa/db')) => Promise<T>) => {
  const m = await dbm();
  return m.withUser(userId, (tx) => fn(tx, m));
};

/** Thrown inside a transaction to roll it back with a domain error. */
export class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}
export const guard = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof Abort) return { ok: false, error: e.error };
    throw e;
  }
};
