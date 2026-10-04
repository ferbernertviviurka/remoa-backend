import { and, eq, sql } from 'drizzle-orm';
import { db } from './client';
import { boards, cards, edges, profiles, reviewQueue } from './schema';

const PLACEHOLDER = 'Diretriz de estudo, rascunho sem revisão médica';
const MARK = 'Enamed 2026.2';

const maps: { title: string; source: string; points: string[] }[] = [
  { title: 'Sepse e choque séptico', source: 'Instituto Latino-Americano de Sepse. Protocolo gerenciado de sepse, pacote da primeira hora.', points: ['Sepse', 'Choque séptico', 'Noradrenalina', 'PAM', 'Lactato', 'Hemocultura', 'Antibiótico', 'Cristaloide', 'qSOFA', 'SOFA', 'Foco infeccioso', 'Reavaliação'] },
  { title: 'Insuficiência cardíaca descompensada', source: 'Sociedade Brasileira de Cardiologia. Diretriz de insuficiência cardíaca crônica e aguda.', points: ['Congestão', 'Perfil hemodinâmico', 'Furosemida', 'Nitroglicerina', 'Dobutamina', 'BNP', 'Restrição hídrica', 'Peso diário', 'IECA', 'Betabloqueador', 'Espironolactona', 'Choque cardiogênico'] },
  { title: 'Pneumonia', source: 'Sociedade Brasileira de Pneumologia e Tisiologia. Diretriz de pneumonia adquirida na comunidade.', points: ['CURB-65', 'PAC', 'Antibiótico empírico', 'Oxigenoterapia', 'Hemocultura', 'Antígeno urinário', 'Derrame', 'Sepse', 'Vacina', 'Reavaliação 48h', 'Isolamento', 'Complicação'] },
  { title: 'Cetoacidose diabética', source: 'Sociedade Brasileira de Diabetes. Diretriz de cetoacidose diabética.', points: ['Hiperglicemia', 'Cetonemia', 'Acidose', 'Insulina', 'Potássio', 'Hidratação', 'Gap aniônico', 'Glicose', 'Bicarbonato', 'Fósforo', 'Desencadeante', 'Resolução'] },
  { title: 'Hipertensão arterial', source: 'Sociedade Brasileira de Cardiologia. Diretriz brasileira de hipertensão arterial.', points: ['Medida correta', 'MAPA', 'Lesão de órgão', 'IECA', 'BRA', 'Tiazídico', 'Bloqueador de canal', 'Urgência', 'Emergência', 'Meta pressórica', 'Adesão', 'Risco cardiovascular'] },
];

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
      await db.insert(reviewQueue).values({ cardId: id, status: 'pending' });
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
    await db.insert(reviewQueue).values({ cardId: caseId, status: 'pending' });
  }
  if (previous) await ensureConceptLink(boardId, previous, caseId, 'caso');
}

export async function seedStudyMaps() {
  await db.execute(sql`insert into auth.users (id, email, instance_id, aud, role)
    values (${reviewer}, 'revisor@remoa.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
    on conflict (id) do nothing`);
  await db.insert(profiles).values({ userId: reviewer, name: 'Revisor', role: 'reviewer' }).onConflictDoUpdate({ target: profiles.userId, set: { role: 'reviewer' } });
  for (const map of maps) {
    const existing = await db.select({ id: boards.id }).from(boards).where(sql`${boards.userId} = ${reviewer} and ${boards.title} = ${map.title}`).limit(1);
    if (existing[0]) {
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
      continue;
    }
    const [board] = await db.insert(boards).values({ userId: reviewer, title: map.title, area: 'CM', status: 'seed_draft', temporalMark: MARK }).returning();
    const ids: string[] = [];
    let order = 0;
    for (const point of map.points) {
      for (const angle of ['definição', 'conduta', 'o que não esquecer'] as const) {
        const title = `${point}: ${angle}`;
        const [card] = await db.insert(cards).values({
          boardId: board!.id, type: 'concept', title, back: `${title}. ${map.source}.`, source: map.source, rubric: rubricFor(`${title}. ${map.source}.`, map.source), status: 'draft', order, x: 80 + (order % 6) * 40, y: 80 + Math.floor(order / 6) * 40,
        }).returning();
        ids.push(card!.id);
        await db.insert(reviewQueue).values({ cardId: card!.id, status: 'pending' });
        order += 1;
      }
    }
    if (ids[0] && ids[1]) await db.insert(edges).values({ boardId: board!.id, fromCardId: ids[0], toCardId: ids[1], label: 'leva a' });
    await ensureStructure(board!.id, map.title, map.points, map.source);
  }
}
