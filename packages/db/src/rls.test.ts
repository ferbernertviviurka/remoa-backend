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

  it('student cannot soft-delete or undelete their own account directly (F08: deleted_at is server-owned)', async () => {
    await expect(m.withUser(b, (tx) => tx.update(s.profiles).set({ deletedAt: new Date(0) }).where(eq(s.profiles.userId, b)))).rejects.toThrow();
    await m.withUser(b, (tx) => tx.update(s.profiles).set({ name: 'ok' }).where(eq(s.profiles.userId, b)));
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

  it('fsrs_state and attempts only for readable cards, never for another user (F03, P-004)', async () => {
    const [priv] = await m.withUser(a, (tx) => tx.insert(s.boards).values({ userId: a, title: 'privado' }).returning());
    const [pc] = await m.withUser(a, (tx) => tx.insert(s.cards).values({ boardId: priv!.id, title: 'c' }).returning());
    const [seed] = await m.db.insert(s.boards).values({ userId: a, title: 'seed', status: 'seed_approved' }).returning();
    const [sc] = await m.db.insert(s.cards).values({ boardId: seed!.id, title: 's' }).returning();
    const st = (userId: string, cardId: string) => ({ userId, cardId, subId: '', due: new Date() });
    const at = (userId: string, cardId: string) => ({ userId, cardId, mode: 'hidden_card' as const, inputKind: 'self' as const, grade: 3, durationMs: 1 });

    await expect(m.withUser(b, (tx) => tx.insert(s.fsrsState).values(st(b, pc!.id)))).rejects.toThrow(); // unreadable card
    await expect(m.withUser(b, (tx) => tx.insert(s.attempts).values(at(b, pc!.id)))).rejects.toThrow();
    await expect(m.withUser(b, (tx) => tx.insert(s.fsrsState).values(st(a, sc!.id)))).rejects.toThrow(); // someone else's row
    await expect(m.withUser(b, (tx) => tx.insert(s.attempts).values(at(a, sc!.id)))).rejects.toThrow();
    await m.withUser(b, (tx) => tx.insert(s.fsrsState).values(st(b, sc!.id))); // readable seed card
    await m.withUser(b, (tx) => tx.insert(s.attempts).values(at(b, sc!.id)));
    expect(await m.withUser(a, (tx) => tx.select().from(s.fsrsState).where(eq(s.fsrsState.cardId, sc!.id)))).toHaveLength(0); // A cannot read B's state
    expect(await m.withUser(a, (tx) => tx.select().from(s.attempts).where(eq(s.attempts.cardId, sc!.id)))).toHaveLength(0);
  });

  it('F13: user_preferences own row only; reminder_last_sent_on server-owned', async () => {
    await m.withUser(a, (tx) => tx.insert(s.userPreferences).values({ userId: a, reminderEnabled: true, newCardsPerDay: 15 }));
    await m.withUser(a, (tx) => tx.update(s.userPreferences).set({ theme: 'system', reduceMotion: true }).where(eq(s.userPreferences.userId, a)));
    await expect(m.withUser(b, (tx) => tx.insert(s.userPreferences).values({ userId: a }))).rejects.toThrow();
    expect(await m.withUser(b, (tx) => tx.select().from(s.userPreferences).where(eq(s.userPreferences.userId, a)))).toHaveLength(0);
    const changed = await m.withUser(b, (tx) => tx.update(s.userPreferences).set({ theme: 'dark' }).where(eq(s.userPreferences.userId, a)).returning());
    expect(changed).toHaveLength(0);
    await expect(m.withUser(a, (tx) => tx.update(s.userPreferences).set({ reminderLastSentOn: '2026-10-02' }).where(eq(s.userPreferences.userId, a)))).rejects.toThrow();
    await expect(m.withUser(a, (tx) => tx.update(s.userPreferences).set({ reminderHour: 9 }).where(eq(s.userPreferences.userId, a)))).rejects.toThrow(); // check
    const [row] = await m.db.select().from(s.userPreferences).where(eq(s.userPreferences.userId, a));
    expect(row).toMatchObject({ theme: 'system', reduceMotion: true, reminderEnabled: true, newCardsPerDay: 15, reminderHour: 19 });
  });

  it('F13: account_events readable by owner, never written by the client', async () => {
    await m.db.insert(s.accountEvents).values({ userId: a, type: 'password_changed' }); // server connection
    await expect(m.withUser(a, (tx) => tx.insert(s.accountEvents).values({ userId: a, type: 'export_requested' }))).rejects.toThrow();
    expect(await m.withUser(a, (tx) => tx.select().from(s.accountEvents).where(eq(s.accountEvents.userId, a)))).toHaveLength(1);
    expect(await m.withUser(b, (tx) => tx.select().from(s.accountEvents).where(eq(s.accountEvents.userId, a)))).toHaveLength(0);
    expect(await m.withUser(a, (tx) => tx.delete(s.accountEvents).where(eq(s.accountEvents.userId, a)).returning()).catch(() => 'denied')).toBe('denied');
  });

  it('F13: profile avatar_color/stage self-editable, avatar_key and deleted_at server-owned', async () => {
    await m.withUser(b, (tx) => tx.update(s.profiles).set({ avatarColor: 3, stage: 'y5_6', goal: 'undecided' }).where(eq(s.profiles.userId, b)));
    await expect(m.withUser(b, (tx) => tx.update(s.profiles).set({ avatarKey: `avatars/${a}/x.webp` }).where(eq(s.profiles.userId, b)))).rejects.toThrow();
    await expect(m.withUser(b, (tx) => tx.update(s.profiles).set({ avatarColor: 7 }).where(eq(s.profiles.userId, b)))).rejects.toThrow(); // check
    await expect(m.withUser(b, (tx) => tx.update(s.profiles).set({ deletedAt: new Date() }).where(eq(s.profiles.userId, b)))).rejects.toThrow();
  });
});
