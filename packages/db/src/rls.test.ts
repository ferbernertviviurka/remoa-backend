// Needs local Supabase (`pnpm db:up && pnpm db:migrate`). Env: DATABASE_URL from the repo-root .env (`pnpm db:env > .env`) (loaded below);
// skipped when absent.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('RLS', () => {
  const a = randomUUID();
  const b = randomUUID();
  let m: typeof import('./client');
  let s: typeof import('./schema');
  let eq: typeof import('drizzle-orm').eq;

  beforeAll(async () => {
    m = await import('./client');
    s = await import('./schema');
    eq = (await import('drizzle-orm')).eq;
    for (const id of [a, b]) {
      await m.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    }
  });

  afterAll(async () => {
    if (!m) return;
    await m.db.execute(sql.raw(`delete from auth.users where id in ('${a}', '${b}')`)); // cascades boards/profiles
  });

  it('trigger creates a profile', async () => {
    const rows = await m.db.select().from(s.profiles).where(eq(s.profiles.userId, a));
    expect(rows[0]?.role).toBe('student');
    expect(rows[0]?.timezone).toBe('America/Sao_Paulo');
  });

  it('B cannot read A private board, can read seed_approved', async () => {
    const [priv] = await m.withUser(a, (tx) => tx.insert(s.boards).values({ userId: a, title: 'privado' }).returning());
    const [seed] = await m.db.insert(s.boards).values({ userId: a, title: 'seed', status: 'seed_approved' }).returning();
    const [draft] = await m.db.insert(s.boards).values({ userId: a, title: 'rascunho', status: 'seed_draft' }).returning();
    const [card] = await m.db.insert(s.cards).values({ boardId: priv!.id, title: 'c' }).returning();

    const seen = await m.withUser(b, (tx) => tx.select({ id: s.boards.id }).from(s.boards));
    const ids = seen.map((r) => r.id);
    expect(ids).toContain(seed!.id);
    expect(ids).not.toContain(priv!.id);
    expect(ids).not.toContain(draft!.id);

    const cardsSeenByB = await m.withUser(b, (tx) => tx.select().from(s.cards).where(eq(s.cards.id, card!.id)));
    expect(cardsSeenByB).toHaveLength(0);
    const cardsSeenByA = await m.withUser(a, (tx) => tx.select().from(s.cards).where(eq(s.cards.id, card!.id)));
    expect(cardsSeenByA).toHaveLength(1);
  });

  it('student cannot publish a seed or escalate role', async () => {
    await expect(m.withUser(b, (tx) => tx.insert(s.boards).values({ userId: b, title: 'x', status: 'seed_approved' }))).rejects.toThrow();
    await expect(m.withUser(b, (tx) => tx.update(s.profiles).set({ role: 'admin' }).where(eq(s.profiles.userId, b)))).rejects.toThrow();
  });

  it('edge cannot point at a card from another board (P-004)', async () => {
    const [b1] = await m.withUser(a, (tx) => tx.insert(s.boards).values({ userId: a, title: 'b1' }).returning());
    const [b2] = await m.withUser(a, (tx) => tx.insert(s.boards).values({ userId: a, title: 'b2' }).returning());
    const [c1] = await m.withUser(a, (tx) => tx.insert(s.cards).values({ boardId: b1!.id, title: 'c1' }).returning());
    const [c2] = await m.withUser(a, (tx) => tx.insert(s.cards).values({ boardId: b1!.id, title: 'c2' }).returning());
    const [other] = await m.withUser(a, (tx) => tx.insert(s.cards).values({ boardId: b2!.id, title: 'x' }).returning());
    await m.withUser(a, (tx) => tx.insert(s.edges).values({ boardId: b1!.id, fromCardId: c1!.id, toCardId: c2!.id }));
    await expect(m.withUser(a, (tx) => tx.insert(s.edges).values({ boardId: b1!.id, fromCardId: c1!.id, toCardId: other!.id }))).rejects.toThrow();
  });
});
