import { extractOffline, layout, rubricFromCard } from '@remoa/ai';
import { and, eq, sql } from 'drizzle-orm';
import { db } from './client';
import { isUntouchedStubSeed } from './seed/stub-board';
import { matrixCodeByTitle, studyOutlines } from './seed/study-outlines';
import { boardMatrixItems, boards, cards, edges, matrixItems, profiles, reviewQueue } from './schema';

const PLACEHOLDER = 'Diretriz de estudo, rascunho sem revisão médica';
const MARK = 'Enamed 2026.2';

const maps = studyOutlines.map((map) => ({
  ...map,
  points: extractOffline(map.text, map.source).cards.filter((c) => c.type === 'concept').map((c) => c.title),
}));

async function linkMatrix(boardId: string, title: string) {
  for (const code of matrixCodeByTitle[title] ?? []) {
    const [item] = await db.select({ id: matrixItems.id }).from(matrixItems).where(eq(matrixItems.code, code)).limit(1);
    if (!item) throw new Error(`matrix item ${code} missing: run db:seed before seed:maps`);
    await db.insert(boardMatrixItems).values({ boardId, matrixItemId: item.id }).onConflictDoNothing();
    await db.update(boards).set({ matrixItemId: item.id }).where(and(eq(boards.id, boardId), sql`${boards.matrixItemId} is null`));
  }
}

const reviewer = '00000000-0000-4000-8000-0000000000f1';

const rubricFor = (text: string, source: string) => ({
  points: [{ text, essential: true }],
  source,
  version: 1,
  status: 'draft' as const,
  reviewerId: null,
});

const flowsFor = (title: string, points: string[]) => [
  { title: `Conduta de ${title}`, steps: [{ id: 's1', text: points[0]! }, { id: 's2', text: points[1]! }] },
  { title: `Reavaliação de ${title}`, steps: [{ id: 'r1', text: points[2] ?? points[0]! }, { id: 'r2', text: points[3] ?? points[1]! }] },
];

async function nextOrder(boardId: string) {
  const [row] = await db.execute<{ n: number }>(sql`select coalesce(max("order"), -1)::int as n from cards where board_id = ${boardId}`);
  return (row?.n ?? -1) + 1;
}

async function ensureConceptLink(boardId: string, fromId: string, toId: string, label: string) {
  const [edge] = await db.select({ id: edges.id }).from(edges).where(and(eq(edges.boardId, boardId), eq(edges.fromCardId, fromId), eq(edges.toCardId, toId))).limit(1);
  if (!edge) await db.insert(edges).values({ boardId, fromCardId: fromId, toCardId: toId, label });
}

/** Two flowcharts and one case per seed, each with a source and a draft rubric, queued for review. */
async function ensureStructure(boardId: string, title: string, points: string[], source: string) {
  const [first] = await db.select({ id: cards.id }).from(cards).where(eq(cards.boardId, boardId)).limit(1);
  let previous: string | null = first?.id ?? null;
  for (const flow of flowsFor(title, points)) {
    const [found] = await db.select({ id: cards.id }).from(cards).where(and(eq(cards.boardId, boardId), eq(cards.title, flow.title))).limit(1);
    let id = found?.id;
    if (!id) {
      const order = await nextOrder(boardId);
      const back = `${flow.title}. ${source}.`;
      const [card] = await db.insert(cards).values({
        boardId, type: 'flow', title: flow.title, back, source, rubric: rubricFor(back, source),
        payload: { steps: flow.steps }, status: 'draft', order, x: 360, y: 80 + order,
      }).returning();
      id = card!.id;
      await db.insert(reviewQueue).values({ cardId: id, status: 'pending', flagSource: 'ai' });
    }
    if (previous && previous !== id) await ensureConceptLink(boardId, previous, id, 'conduta');
    previous = id;
  }
  const caseTitle = `Caso de ${title}`;
  const [caseRow] = await db.select({ id: cards.id }).from(cards).where(and(eq(cards.boardId, boardId), eq(cards.title, caseTitle))).limit(1);
  let caseId = caseRow?.id;
  if (!caseId) {
    const order = await nextOrder(boardId);
    const back = `${caseTitle}. ${source}.`;
    const [card] = await db.insert(cards).values({
      boardId, type: 'case', title: caseTitle, back, source, rubric: rubricFor(back, source),
      payload: { caseSteps: [{ stage: 'presentation', text: points[0]! }, { stage: 'management', text: points[2] ?? points[0]! }] },
      status: 'draft', order, x: 360, y: 260,
    }).returning();
    caseId = card!.id;
    await db.insert(reviewQueue).values({ cardId: caseId, status: 'pending', flagSource: 'ai' });
  }
  if (previous) await ensureConceptLink(boardId, previous, caseId, 'caso');
}

async function insertExtracted(boardId: string, map: { text: string; source: string }) {
  const extracted = extractOffline(map.text, map.source);
  const places = new Map(layout(extracted.cards, extracted.edges).map((p) => [p.ref, p]));
  const ids = new Map<string, string>();
  let order = 0;
  for (const card of extracted.cards) {
    const place = places.get(card.ref);
    const back = card.back ?? card.title;
    const [row] = await db.insert(cards).values({
      boardId, type: card.type, title: card.title, back, source: map.source,
      rubric: rubricFromCard(card.title, back, map.source), payload: card.payload,
      status: 'draft', order, x: place?.x ?? 80, y: place?.y ?? 80,
    }).returning();
    ids.set(card.ref, row!.id);
    await db.insert(reviewQueue).values({ cardId: row!.id, status: 'pending', flagSource: 'ai' });
    order += 1;
  }
  for (const edge of extracted.edges) {
    const from = ids.get(edge.fromRef);
    const to = ids.get(edge.toRef);
    if (from && to) await db.insert(edges).values({ boardId, fromCardId: from, toCardId: to, label: edge.label });
  }
}

export async function seedStudyMaps() {
  await db.execute(sql`insert into auth.users (id, email, instance_id, aud, role)
    values (${reviewer}, 'revisor@remoa.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
    on conflict (id) do nothing`);
  await db.insert(profiles).values({ userId: reviewer, name: 'Revisor Remoa', crm: '123456-SP', role: 'reviewer' }).onConflictDoUpdate({ target: profiles.userId, set: { name: 'Revisor Remoa', crm: '123456-SP', role: 'reviewer' } });
  for (const map of maps) {
    const existing = await db.select({ id: boards.id }).from(boards).where(sql`${boards.userId} = ${reviewer} and ${boards.title} = ${map.title}`).limit(1);
    if (existing[0]) {
      const boardId = existing[0].id;
      const rows = await db.select({ title: cards.title, status: cards.status }).from(cards).where(eq(cards.boardId, boardId));
      const [used] = await db.execute<{ n: number }>(sql`select count(*)::int as n from attempts a join cards c on c.id = a.card_id where c.board_id = ${boardId}`);
      if (isUntouchedStubSeed(map.title, rows) && (used?.n ?? 0) === 0) {
        await db.delete(cards).where(eq(cards.boardId, boardId));
        await insertExtracted(boardId, map);
        await linkMatrix(boardId, map.title);
        continue;
      }
      await db.execute(sql`
        update cards set rubric = jsonb_build_object(
          'points', jsonb_build_array(jsonb_build_object('text', coalesce(back, title), 'essential', true)),
          'source', ${map.source}::text,
          'version', 1,
          'status', 'draft',
          'reviewerId', null
        )
        where board_id = ${existing[0].id} and rubric is null
      `);
      await db.execute(sql`
        update cards
        set source = ${map.source}::text,
            back = replace(back, ${PLACEHOLDER}::text, ${map.source}::text),
            rubric = jsonb_set(rubric, '{source}', to_jsonb(${map.source}::text))
        where board_id = ${existing[0].id} and source = ${PLACEHOLDER}::text and rubric is not null
      `);
      await ensureStructure(existing[0].id, map.title, map.points, map.source);
      await linkMatrix(existing[0].id, map.title);
      continue;
    }
    const [board] = await db.insert(boards).values({ userId: reviewer, title: map.title, area: 'CM', status: 'seed_draft', temporalMark: MARK }).returning();
    await insertExtracted(board!.id, map);
    await linkMatrix(board!.id, map.title);
  }
  const sources = [...new Set(maps.map((map) => map.source))];
  await db.execute(sql`
    update review_queue q
    set flag_source = 'ai'
    from cards c
    join boards b on b.id = c.board_id
    where q.card_id = c.id
      and q.flag_source is null
      and q.status = 'pending'
      and b.status = 'seed_draft'
      and c.source in (${sql.join(sources.map((source) => sql`${source}`), sql`, `)})
  `);
}
