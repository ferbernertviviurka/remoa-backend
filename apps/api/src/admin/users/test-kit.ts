// Test-only (F19 T5): a real app (createApp + fakeVerifier), real Supabase Auth users, real DB. Lazy imports: loads without DATABASE_URL.
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { dropTrial } from '../../test-trial';
import { fakeToken, fakeVerifier } from '../core/test-helpers';

export type Json = { data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function kit() {
  const dbm = await import('@remoa/db');
  const supa = (await import('../../account/auth-admin')).adminClient();
  const { createApp } = await import('../../app');
  const ids: string[] = [];
  const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: fakeVerifier(ids) });
  const newUser = async (role: 'admin' | 'student' | 'reviewer' = 'student', name = 'Pessoa Teste') => {
    const { data, error } = await supa.auth.admin.createUser({ email: `t5-${uuid()}@test.local`, password: 'senha1234', email_confirm: true });
    if (error) throw error;
    ids.push(data.user.id);
    await dropTrial(data.user.id);
    await dbm.db.update(dbm.profiles).set({ role, name }).where(eq(dbm.profiles.userId, data.user.id));
    return { id: data.user.id, email: data.user.email!, name };
  };
  const call = async (path: string, init: { method?: string; as?: string | null; body?: unknown; ago?: number } = {}) => {
    const res = await app.request(path, {
      method: init.method ?? 'GET',
      headers: { ...(init.as ? { authorization: `Bearer ${fakeToken(init.as, init.ago ?? 60_000)}` } : {}), 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, res, json: (res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()) as Json };
  };
  /** Audit rows of one action on one target, oldest first. */
  const audit = (action: string, targetId: string) =>
    dbm.db.select().from(dbm.adminAuditLog).where(and(eq(dbm.adminAuditLog.action, action), eq(dbm.adminAuditLog.targetId, targetId))).orderBy(dbm.adminAuditLog.id);
  const board = async (userId: string, o: { title?: string; status?: string; cards?: number } = {}) => {
    const [b] = await dbm.db.execute<{ id: string }>(sql`insert into boards (user_id, title, status) values (${userId}, ${o.title ?? 'Mapa teste'}, ${o.status ?? 'private'}) returning id`);
    const cs: string[] = [];
    for (let i = 0; i < (o.cards ?? 0); i++) {
      const [c] = await dbm.db.execute<{ id: string }>(sql`insert into cards (board_id, title, front, back) values (${b!.id}, ${`Conceito secreto ${i}`}, 'frente sigilosa', 'verso sigiloso') returning id`);
      cs.push(c!.id);
    }
    if (cs.length > 1) await dbm.db.execute(sql`insert into edges (board_id, from_card_id, to_card_id, label) values (${b!.id}, ${cs[0]}, ${cs[1]}, 'liga')`);
    return b!.id;
  };
  const cleanup = async () => {
    for (const id of ids) await supa.auth.admin.deleteUser(id);
  };
  return { dbm, supa, app, ids, newUser, call, audit, board, cleanup };
}
export type Kit = Awaited<ReturnType<typeof kit>>;
