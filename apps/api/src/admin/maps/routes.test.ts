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
  it('seeds: institutional approval ("Aprovado por Remoa") of a F31 ready-made map; non-admin 404; physician provenance unchanged', async () => {
    const slug = `inst-${crypto.randomUUID().slice(0, 8)}`;
    const path = { slug, modulos: ['M1'], area: 'Clínica Médica', dominios: [], competencias: [], revisarAte: '2027-01-01', versao: '2026.1', aviso: 'x' };
    const mk = async (title: string, p: unknown, mark: string | null) =>
      (await k.dbm.db.insert(k.dbm.boards).values({ userId: owner.id, title, status: 'seed_draft', area: 'CM', path: p as never, temporalMark: mark }).returning())[0]!.id;
    const seed = await mk('Trilha Institucional', path, 'Diretriz 2025');
    const [c1, c2] = await k.dbm.db.insert(k.dbm.cards).values([
      { boardId: seed, title: 'A', status: 'draft', pathOrder: 1 }, { boardId: seed, title: 'B', status: 'draft', pathOrder: 2 },
    ]).returning();
    await k.dbm.db.insert(k.dbm.edges).values({ boardId: seed, fromCardId: c1!.id, toCardId: c2!.id, label: 'leva a' });
    await k.dbm.db.insert(k.dbm.cards).values({ boardId: seed, title: 'apagado', status: 'draft', pathOrder: 3, deletedAt: new Date() });
    const inst = { reason: 'Aprovação institucional dos mapas prontos', institutional: true };

    const student = await k.newUser('student', 'Aluno Curioso');
    expect((await k.call(`/v1/admin/seeds/${seed}/approve`, { method: 'POST', as: student.id, body: inst })).status).toBe(404);
    expect((await post(`/seeds/${seed}/approve`, { ...inst, institutional: 'true' })).status).toBe(409); // only literal true; else physician path
    const plain = await mk('Seed sem trilha', null, 'Diretriz 2025');
    await k.dbm.db.insert(k.dbm.cards).values({ boardId: plain, title: 'X', status: 'draft', pathOrder: 1 });
    expect((await post(`/seeds/${plain}/approve`, inst)).status).toBe(409); // only boards with path
    const stray = await mk('Trilha com card solto', { ...path, slug: `${slug}-b` }, 'Diretriz 2025');
    await k.dbm.db.insert(k.dbm.cards).values({ boardId: stray, title: 'Fora do build', status: 'draft' });
    expect((await post(`/seeds/${stray}/approve`, inst)).status).toBe(409); // card without path_order: rolled back
    expect((await k.dbm.db.select().from(k.dbm.cards).where(eq(k.dbm.cards.boardId, stray)))[0]!.status).toBe('draft');

    const r = await post(`/seeds/${seed}/approve`, inst);
    expect(r.status).toBe(200);
    expect(r.json.data.audit).toMatchObject({ before: { status: 'seed_draft' }, after: { status: 'seed_approved', approvedBy: 'remoa', version: 2, cards: 2, temporalMark: 'Diretriz 2025', contentVersion: '2026.1' } });
    const [b] = await k.dbm.db.select().from(k.dbm.boards).where(eq(k.dbm.boards.id, seed));
    expect([b!.status, b!.version, b!.temporalMark, b!.reviewerId]).toEqual(['seed_approved', 2, 'Diretriz 2025', null]);
    const live = await k.dbm.db.execute<{ status: string; reviewer_id: string | null }>(sql`select status, reviewer_id from cards where board_id = ${seed} and deleted_at is null`);
    expect([...live].map((c) => [c.status, c.reviewer_id])).toEqual([['approved', null], ['approved', null]]);
    const [v] = await k.dbm.db.select().from(k.dbm.boardVersions).where(eq(k.dbm.boardVersions.boardId, seed));
    const snap = v!.snapshot as { cards: { status: string; pathOrder: number }[]; edges: unknown[]; approvedBy: string; reviewerName: null; reviewerCrm: null; temporalMark: string };
    expect([v!.version, v!.reviewerId, snap.approvedBy, snap.reviewerName, snap.reviewerCrm, snap.temporalMark, snap.edges.length]).toEqual([2, null, 'remoa', null, null, 'Diretriz 2025', 1]);
    expect(snap.cards.map((c) => [c.status, c.pathOrder]).sort()).toEqual([['approved', 1], ['approved', 2]]);
    expect((await k.audit('seed.approve', seed)).map((x) => [x.result, x.denial])).toEqual([['denied', 'invalid_state'], ['success', null]]);
    expect((await post(`/seeds/${seed}/approve`, inst)).status).toBe(409); // once

    const pub = (await k.call('/v1/public/mapas-prontos')).json.data as { slug: string; approvedBy: string; reviewerName: string | null; reviewerCrm: string | null }[];
    expect(pub.find((x) => x.slug === slug)).toMatchObject({ approvedBy: 'remoa', reviewerName: null, reviewerCrm: null });
    expect((await k.call(`/v1/public/mapas-prontos/${slug}`)).json.data).toMatchObject({ approvedBy: 'remoa', reviewerCrm: null });
    const lib = (await k.call('/v1/editorial/seeds', { as: student.id })).json.data as { id: string; approvedBy: string }[];
    expect(lib.find((x) => x.id === seed)?.approvedBy).toBe('remoa');
    expect((await k.call(`/v1/editorial/seeds/${seed}`, { as: student.id })).json.data).toMatchObject({ approvedBy: 'remoa', reviewerName: null });

    // a physician edition (publishBoard snapshot, no approvedBy key) still reads as reviewer with name + CRM
    const med = await k.board(owner.id, { title: 'Seed medica', status: 'seed_approved' });
    await k.dbm.db.insert(k.dbm.boardVersions).values({ boardId: med, version: 1, snapshot: { cards: [], edges: [], reviewerName: 'Dra. Ana', reviewerCrm: '123456-SP' }, approvedAt: new Date() });
    expect((await k.call(`/v1/editorial/seeds/${med}`, { as: student.id })).json.data).toMatchObject({ approvedBy: 'reviewer', reviewerName: 'Dra. Ana', reviewerCrm: '123456-SP' });
  });
});
