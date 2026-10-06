import { describe, expect, it } from 'vitest';
import { guard } from './db';

describe('guard', () => {
  it('maps an RLS WITH CHECK violation (42501, also wrapped by Drizzle) to a 409 conflict, not a 500', async () => {
    const rls = Object.assign(new Error('new row violates row-level security policy for table "edges"'), { code: '42501' });
    expect(await guard(async () => { throw rls; })).toEqual({ ok: false, error: { code: 'conflict', message: 'stale_state' } });
    expect(await guard(async () => { throw new Error('Failed query', { cause: rls }); })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
  it('other database errors still throw', async () => {
    await expect(guard(async () => { throw Object.assign(new Error('x'), { code: '23505' }); })).rejects.toThrow('x');
  });
});
