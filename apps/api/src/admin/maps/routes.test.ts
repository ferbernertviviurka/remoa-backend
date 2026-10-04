// F19 T5 integration: /v1/admin/maps and /v1/admin/seeds. Needs local Supabase.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminMapPageSchema } from '@remoa/contracts';
import { kit, type Kit } from '../users/test-kit';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('F19 /v1/admin/maps + seeds', () => {
  let k: Kit;
  let adm: { id: string };
  let owner: { id: string; email: string };
  beforeAll(async () => {
    k = await kit();
    adm = await k.newUser('admin', 'Admin Mapas');
    owner = await k.newUser('student', 'Dona Do Mapa');
  });
  afterAll(async () => k?.cleanup());
  const post = (path: string, body: unknown = { reason: 'Denúncia de conteúdo #7' }) => k.call(`/v1/admin${path}`, { method: 'POST', as: adm.id, body });

  it('list filters by origin/status/q with counts; derived origins; drawer carries no card content', async () => {
    const manual = await k.board(owner.id, { title: 'Manual Unico Alfa', cards: 3 });
    const src = await k.board(owner.id, { title: 'Origem', status: 'seed_approved' });
    const copy = await k.board(owner.id, { title: 'Copia Unica Beta' });
    await k.dbm.db.execute(sql`update boards set source_board_id = ${src} where id = ${copy}`);
    const link = await k.board(owner.id, { title: 'Link Unico Gama' });
    await k.dbm.db.execute(sql`update boards set copied_from_link_at = now(), source_board_id = ${src} where id = ${link}`);
    const imp = await k.board(owner.id, { title: 'Import Unico Delta' });
    await k.dbm.db.execute(sql`insert into cards (board_id, title, source) values (${imp}, 'x', 'Anki')`);
    const list = async (qs: string) => adminMapPageSchema.parse((await k.call(`/v1/admin/maps?${qs}`, { as: adm.id })).json.data);
    const origin = async (title: string) => (await list(`q=${encodeURIComponent(title)}`)).items[0]!.origin;
    expect([await origin('Manual Unico'), await origin('Copia Unica'), await origin('Link Unico'), await origin('Import Unico'), await origin('Origem')]).toEqual(['manual', 'seed_copy', 'link_copy', 'import', 'seed']);
    const m = await list('q=Manual%20Unico%20Alfa');
    expect(m.items[0]).toMatchObject({ id: manual, cards: 3, edges: 1, status: 'private', owner: { id: owner.id, name: 'Dona Do Mapa', email: owner.email } });
    expect(m.items[0]!.area).toBe('CM');
    const sum = await list(`q=${owner.email}&status=seed_approved`); // summary counts q only, ignoring status/origin
    expect(sum.summary).toEqual({ total: 5, private: 4, seedDraft: 0, seedApproved: 1 });
    const { getExport } = await import('../core');
    const out = await k.dbm.db.transaction((tx) => getExport('maps')!({ q: owner.email, origin: 'seed_copy' }, tx));
    expect(out.ok && out.data.rows.map((r) => [r[0], r[2], r[8]])).toEqual([[copy, 'CM', 'seed_copy']]);
    expect((await list(`q=${owner.email}&origin=seed_copy`)).items.map((i) => i.id)).toEqual([copy]);
    expect((await list(`q=${owner.email}&status=seed_approved`)).total).toBe(1);
    expect((await k.call('/v1/admin/maps?origin=bad', { as: adm.id })).status).toBe(422);
    const det = await k.call(`/v1/admin/maps/${manual}`, { as: adm.id });
    expect(det.status).toBe(200);
    expect(det.json.data).toMatchObject({ id: manual, area: 'CM', cards: 3 });
    expect(JSON.stringify(det.json)).not.toMatch(/sigilos|secreto/);
    expect((await k.call(`/v1/admin/maps/${crypto.randomUUID()}`, { as: adm.id })).status).toBe(404);
  });

  it('open: no reason = 422 + denied row; with reason returns the graph read-only, audit keeps counts only; stale login = reauth', async () => {
    const id = await k.board(owner.id, { title: 'Aberto', cards: 2 });
    expect((await post(`/maps/${id}/open`, {})).status).toBe(422);
    expect((await post(`/maps/${id}/open`, { reason: 'curto' })).status).toBe(422);
    expect((await k.audit('map.open_readonly', id)).map((r) => [r.result, r.denial])).toEqual([['denied', 'missing_reason'], ['denied', 'missing_reason']]);
    const stale = await k.call(`/v1/admin/maps/${id}/open`, { method: 'POST', as: adm.id, ago: 40 * 60_000, body: { reason: 'Denúncia de conteúdo #7' } });
    expect([stale.status, stale.json.error?.message]).toEqual([403, 'reauth_required']);
    const r = await post(`/maps/${id}/open`);
    expect(r.status).toBe(200);
    expect(r.json.data.graph.cards).toHaveLength(2);
    expect(r.json.data.graph.cards[0].title).toMatch(/Conceito secreto/);
    expect(r.json.data.graph.board).not.toHaveProperty('sharePasswordHash');
    expect(r.json.data.audit).toMatchObject({ action: 'map.open_readonly', result: 'success', after: { cards: 2, edges: 1 } });
    expect(JSON.stringify((await k.audit('map.open_readonly', id)))).not.toMatch(/secreto|sigilos/);
    expect((await k.audit('map.open_readonly', id)).map((x) => x.result)).toEqual(['denied', 'denied', 'denied', 'success']);
    const [c] = await k.dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from cards where board_id = ${id} and deleted_at is null`);
    expect(c?.n).toBe(2); // read-only
  });

  it('open never returns the share link (a standing credential outside the audit trail)', async () => {
    const id = await k.board(owner.id, { title: 'Compartilhado', cards: 1 });
    await k.dbm.db.execute(sql`update boards set access = 'public', share_token = ${`tok-${crypto.randomUUID()}`} where id = ${id}`);
    const r = await post(`/maps/${id}/open`);
    expect(r.status).toBe(200);
    expect(r.json.data.graph.board.shareUrl ?? null).toBeNull();
    expect(JSON.stringify(r.json)).not.toMatch(/tok-/);
  });

  it('archive: once; seeds and unknown ids refused; audit before/after', async () => {
    const id = await k.board(owner.id, { title: 'Arquivar' });
    const r = await post(`/maps/${id}/archive`);
    expect(r.status).toBe(200);
    expect(r.json.data.audit).toMatchObject({ before: { status: 'private' }, after: { status: 'archived' } });
    expect((await k.call(`/v1/admin/maps/${id}`, { as: adm.id })).json.data.status).toBe('archived');
    expect((await post(`/maps/${id}/archive`)).status).toBe(409);
    expect((await k.audit('map.archive', id)).map((x) => [x.result, x.denial])).toEqual([['success', null], ['denied', 'invalid_state']]);
    const seed = await k.board(owner.id, { title: 'Seed', status: 'seed_draft' });
    expect((await post(`/maps/${seed}/archive`)).status).toBe(409);
    expect((await post(`/maps/${crypto.randomUUID()}/archive`)).status).toBe(404);
  });

  it('seeds: approve needs a recorded reviewer; approve/unpublish only from the right state; one audit row each', async () => {
    const seed = await k.board(owner.id, { title: 'Seed Revisada', status: 'seed_draft' });
    expect((await post(`/seeds/${seed}/approve`)).status).toBe(409); // no reviewer recorded
    const student = await k.newUser('student', 'Nao Revisor');
    await k.dbm.db.update(k.dbm.boards).set({ reviewerId: student.id }).where(eq(k.dbm.boards.id, seed));
    expect((await post(`/seeds/${seed}/approve`)).status).toBe(409); // not a reviewer
    const rev = await k.newUser('reviewer', 'Dra. Revisora');
    await k.dbm.db.update(k.dbm.boards).set({ reviewerId: rev.id }).where(eq(k.dbm.boards.id, seed));
    expect((await post(`/seeds/${seed}/approve`)).status).toBe(409); // P-206: reviewer without CRM
    await k.dbm.db.update(k.dbm.profiles).set({ crm: 'CRM-SP 123456' }).where(eq(k.dbm.profiles.userId, rev.id));
    const [draftCard] = await k.dbm.db.insert(k.dbm.cards).values({ boardId: seed, title: 'Ainda rascunho', status: 'draft' }).returning();
    expect((await post(`/seeds/${seed}/approve`)).status).toBe(409); // a card still in draft
    await k.dbm.db.update(k.dbm.cards).set({ status: 'approved' }).where(eq(k.dbm.cards.id, draftCard!.id));
    const ok = await post(`/seeds/${seed}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.json.data.audit).toMatchObject({ before: { status: 'seed_draft', reviewerId: rev.id }, after: { status: 'seed_approved' } });
    expect((await post(`/seeds/${seed}/approve`)).status).toBe(409);
    expect((await k.audit('seed.approve', seed)).map((x) => [x.result, x.denial])).toEqual([['denied', 'invalid_state'], ['denied', 'invalid_state'], ['denied', 'invalid_state'], ['denied', 'invalid_state'], ['success', null], ['denied', 'invalid_state']]);
    expect((await post(`/seeds/${seed}/unpublish`, {})).status).toBe(422);
    expect((await post(`/seeds/${seed}/unpublish`)).status).toBe(200);
    expect((await k.call(`/v1/admin/maps/${seed}`, { as: adm.id })).json.data.status).toBe('seed_draft');
    expect((await post(`/seeds/${seed}/unpublish`)).status).toBe(409);
    const priv = await k.board(owner.id, { title: 'Privado' });
    expect((await post(`/seeds/${priv}/approve`)).status).toBe(409);
    expect((await post(`/seeds/${crypto.randomUUID()}/approve`)).status).toBe(404);
  });
});
