// FR-33/FR-28. DB part needs TEST_DATABASE_URL (vitest.test-db.ts); everything runs in one transaction that is rolled back.
import { randomUUID } from 'node:crypto';
import { mapFileSchema, type ContentReviewDecision, type VerifyResult } from '@remoa/contracts';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { buildMap, publishGate, stableId, verifyGate, type BuildOptions } from './build';
import { loadBundle } from './load';
import { rawMap, SLUG, TEST_TARGETS, writeFixture } from './test-fixture';

const map = mapFileSchema.parse(rawMap());
const allVerified: VerifyResult[] = map.cards.map((c) => ({ cardId: c.id, veredito: 'sustenta', motivo: 'ok' }));
const allApproved: ContentReviewDecision[] = map.cards.map((c) => ({ cardId: c.id, decisao: 'aprovo' }));

describe('publishGate (FR-28)', () => {
  it('opens only with every card verified, no contradiz and every card approved', () => {
    expect(publishGate(map, allVerified, allApproved)).toEqual([]);
    expect(publishGate(map, [], [])).toEqual(['10 card(s) sem verificação', '10 de 10 card(s) sem "aprovo" do revisor']);
    const contra = allVerified.map((v, i) => (i === 0 ? { ...v, veredito: 'contradiz' as const } : v));
    expect(publishGate(map, contra, allApproved)).toEqual(['1 card(s) com contradiz: t-m0-001', 'sustenta 9 de 10, abaixo de 98%']);
    const later = [...allApproved, { cardId: 't-m1-001', decisao: 'ajustar' as const, nota: 'rever' }];
    expect(publishGate(map, allVerified, later)).toEqual(['1 de 10 card(s) sem "aprovo" do revisor']);
  });

  it('verifyGate (FR-22): every card verified, no contradiz, at least 98% sustenta', () => {
    expect(verifyGate(map, allVerified)).toEqual([]);
    const parcial = allVerified.map((v, i) => (i === 0 ? { ...v, veredito: 'parcial' as const } : v));
    expect(verifyGate(map, parcial)).toEqual(['sustenta 9 de 10, abaixo de 98%']);
    expect(verifyGate(map, allVerified.slice(1))).toEqual(['1 card(s) sem verificação']);
  });

  it('stableId is a deterministic uuid', () => {
    expect(stableId('a', 'b')).toBe(stableId('a', 'b'));
    expect(stableId('a', 'b')).not.toBe(stableId('a', 'c'));
    expect(stableId('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)('content:build (DB)', () => {
  const db = sql!;
  afterAll(() => db.end());

  /** Runs `fn` in a transaction that always rolls back and returns what fn returned. */
  const rolledBack = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    db.begin(async (tx) => {
      throw Object.assign(new Error('rollback'), { out: await fn(tx) });
    }).catch((e: Error & { out?: T }) => {
      if (!('out' in e)) throw e;
      return e.out as T;
    });

  // Unique slug per run, so the test never meets a real seed with the same slug.
  const slug = `${SLUG}-${randomUUID().slice(0, 8)}`;
  const fixture = (edit?: (m: ReturnType<typeof rawMap>) => void) => {
    const m = rawMap();
    m.mapa.slug = slug;
    edit?.(m);
    return loadBundle(slug, writeFixture({ map: m, slug }));
  };
  const opts = (ownerId: string, extra: Partial<BuildOptions> = {}): BuildOptions => ({ ownerId, targets: { [slug]: TEST_TARGETS[SLUG]! }, verify: allVerified, ...extra });
  const counts = async (tx: postgres.TransactionSql, boardId: string) => (await tx`
    select (select count(*)::int from boards where path->>'slug' = ${slug}) boards,
      (select count(*)::int from cards where board_id = ${boardId}) cards,
      (select count(*)::int from edges where board_id = ${boardId}) edges,
      (select count(*)::int from card_prereqs p join cards c on c.id = p.card_id where c.board_id = ${boardId}) prereqs,
      (select count(*)::int from masks m join cards c on c.id = m.card_id where c.board_id = ${boardId}) masks,
      (select count(*)::int from review_queue q join cards c on c.id = q.card_id where c.board_id = ${boardId}) queue,
      (select status from boards where id = ${boardId}) status`)[0]!;

  it('builds a seed_draft and is idempotent: a second run updates instead of duplicating', async () => {
    const out = await rolledBack(async (tx) => {
      const owner = randomUUID();
      await tx`insert into auth.users (id, email) values (${owner}, ${`${owner}@test.remoa`})`;
      const uploads: string[] = [];
      const put = async (key: string) => void uploads.push(key);
      const first = await buildMap(tx, fixture(), opts(owner, { put }));
      if (!first.ok) throw new Error(JSON.stringify(first.error));
      const c1 = await counts(tx, first.data.boardId);
      const [board] = await tx`select title, area, status, temporal_mark, path, badges from boards where id = ${first.data.boardId}`;
      const [card] = await tx`select type, didactics, sources, path_order, status, payload from cards where id = ${stableId(slug, 't-m5-001')}`;
      const [flow] = await tx`select payload from cards where id = ${stableId(slug, 't-m4-001')}`;
      const [kase] = await tx`select payload from cards where id = ${stableId(slug, 't-m7-001')}`;
      const [edge] = await tx`select label from edges where board_id = ${first.data.boardId} limit 1`;
      const [asset] = await tx`select key, width, license from assets where id = ${stableId(slug, 'asset', 'esquema.svg')}`;

      // Reviewer approved one card; an unchanged rebuild keeps it, a changed card goes back to draft.
      await tx`update cards set status = 'approved', reviewer_id = ${owner} where id in (${stableId(slug, 't-m0-001')}, ${stableId(slug, 't-m1-001')})`;
      const second = await buildMap(tx, fixture((m) => {
        (m.cards[1] as { verso: string }).verso = 'Resposta reescrita.';
        m.cards.pop(); // t-m8-002 leaves the file
        m.conexoes.pop();
        m.mapa.titulo = 'Mapa de teste v2';
        m.mapa.metas = { ...m.mapa.metas, cards: 9 };
      }), opts(owner, { targets: { [slug]: { ...TEST_TARGETS[SLUG]!, cards: 9 } } }));
      const third = await buildMap(tx, fixture(), opts(owner));
      const keep = await tx`select id, status from cards where id in (${stableId(slug, 't-m0-001')}, ${stableId(slug, 't-m1-001')}) order by path_order`;
      return { first: first.data, c1, board, card, flow, kase, edge, asset, uploads, second, third, c3: await counts(tx, first.data.boardId), keep, secondTitle: second.ok };
    });
    expect(out.first).toMatchObject({ created: true, cards: 10, edges: 9, prereqs: 1, assets: 1, removed: 0 });
    expect(out.c1).toEqual({ boards: 1, cards: 10, edges: 9, prereqs: 1, masks: 2, queue: 10, status: 'seed_draft' });
    expect(out.board).toMatchObject({ title: 'Mapa de teste', area: 'CM', status: 'seed_draft', temporal_mark: 'ENAMED 2026', badges: ['top10_enamed'] });
    expect(out.board!.path).toMatchObject({ slug, area: 'Clínica Médica', versao: '2026.1', modulos: ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'] });
    expect(out.card).toMatchObject({ type: 'image', path_order: 6, status: 'draft', didactics: { nivel: 1, modulo: 'M5', risco: 'nenhum' } });
    expect(out.card!.sources).toEqual([{ doc: 'doc-a', local: 'seção 1', versao: '2026', acesso: '2026-10-01' }]);
    expect(out.card!.payload.masks).toHaveLength(2);
    expect(out.card!.payload.assetId).toBe(stableId(slug, 'asset', 'esquema.svg'));
    expect(out.flow!.payload).toEqual({ steps: [{ id: 'p1', text: 'Primeiro passo' }, { id: 'p2', text: 'Segundo passo' }] });
    expect(out.kase!.payload.caseSteps.map((s: { stage: string }) => s.stage)).toEqual(['presentation', 'workup', 'diagnosis', 'management']);
    expect(out.edge).toEqual({ label: 'leva a' });
    expect(out.asset).toMatchObject({ width: 1600, license: 'own' });
    expect(out.uploads).toEqual([`${out.asset!.key}/w800.webp`, `${out.asset!.key}/w1600.webp`]);
    expect(out.second).toMatchObject({ ok: true, data: { created: false, cards: 9, removed: 1 } });
    expect(out.third).toMatchObject({ ok: true, data: { created: false, cards: 10, removed: 0 } });
    expect(out.c3).toEqual(out.c1);
    expect(out.keep.map((r) => r.status)).toEqual(['approved', 'draft']);
  });

  it('refuses: unverified draft (P-672), closed gate, open gate (reviewer only) and an already published board', async () => {
    const out = await rolledBack(async (tx) => {
      const owner = randomUUID();
      await tx`insert into auth.users (id, email) values (${owner}, ${`${owner}@test.remoa`})`;
      const b = fixture();
      const closed = await buildMap(tx, b, opts(owner, { status: 'seed_approved', verify: [] }));
      const unverified = await buildMap(tx, b, opts(owner, { verify: allVerified.map((v, i) => (i === 2 ? { ...v, veredito: 'contradiz' as const } : v)) }));
      const verify = b.map!.cards.map((c) => ({ cardId: c.id, veredito: 'sustenta' as const, motivo: 'ok' }));
      const decisions = b.map!.cards.map((c) => ({ cardId: c.id, decisao: 'aprovo' as const }));
      const open = await buildMap(tx, b, opts(owner, { status: 'seed_approved', verify, decisions }));
      const boardsAfterRefusal = (await tx`select count(*)::int n from boards where path->>'slug' = ${slug}`)[0]!.n;
      const draft = await buildMap(tx, b, opts(owner));
      if (!draft.ok) throw new Error('draft build failed');
      await tx`update boards set status = 'seed_approved' where id = ${draft.data.boardId}`;
      const published = await buildMap(tx, b, opts(owner));
      const noOwner = await buildMap(tx, b, opts(randomUUID()));
      const template = await buildMap(tx, loadBundle('_template'), opts(owner));
      const broken = await buildMap(tx, fixture((m) => void (m.cards[0]!.fontes = [])), opts(owner));
      return { closed, unverified, open, boardsAfterRefusal, published, noOwner, template, broken };
    });
    expect(out.closed).toMatchObject({ ok: false, error: { code: 'publish_gate', details: ['10 card(s) sem verificação', '10 de 10 card(s) sem "aprovo" do revisor'] } });
    expect(out.unverified).toMatchObject({ ok: false, error: { code: 'verify_gate', details: ['1 card(s) com contradiz: t-m2-001', 'sustenta 9 de 10, abaixo de 98%'] } });
    expect(out.open).toMatchObject({ ok: false, error: { code: 'reviewer_only' } });
    expect(out.boardsAfterRefusal).toBe(0);
    expect(out.published).toMatchObject({ ok: false, error: { code: 'published' } });
    expect(out.noOwner).toMatchObject({ ok: false, error: { code: 'owner_missing' } });
    expect(out.template).toMatchObject({ ok: false, error: { code: 'lint', message: 'template não é compilado' } });
    expect(out.broken).toMatchObject({ ok: false, error: { code: 'lint' } });
  });
});
