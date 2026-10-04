// F19 FR-15 (D-461): /v1/admin/maps and /v1/admin/seeds. Listing and the drawer never carry card content; opening the graph needs a reason
// (`map.open_readonly`, sensitive, read-only, audited with counts only). Seeds: approve needs a recorded reviewer with name + CRM (F10, D-495).
import { Hono, type Context } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import { adminErrors, adminMapListQuerySchema, err, ok, parseWith, type AdminAction, type AdminMapPage, type AdminMapRow, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { getBoard } from '../../boards/boards';
import { dbm } from '../../db';
import { normalizeCrm } from '../../editorial/editorial';
import { notFound, reasonOf, registerExport, send, withAdmin, type AdminEnv, type AuditCapture } from '../core';
import { dtReq, isUuid, likeOf, trailOf } from '../users/util';

const conflict = () => err<never>('conflict', adminErrors.invalidState);
type C = Context<AdminEnv>;
type Raw = Record<string, unknown>;

// origin precedence: seed > link_copy > seed_copy > import > manual. ponytail: `import` = a card sourced 'Anki' (imports have no board link); add imports.board_id if it must be exact.
const originSql = sql`case when b.status <> 'private' then 'seed' when b.copied_from_link_at is not null then 'link_copy' when b.source_board_id is not null then 'seed_copy'
  when exists (select 1 from cards c where c.board_id = b.id and c.source = 'Anki') then 'import' else 'manual' end`;
const cols = sql`b.id, b.title, b.user_id as owner_id, p.name as owner_name, u.email as owner_email,
  case when b.archived_at is not null then 'archived' else b.status::text end as status, ${originSql} as origin, b.created_at,
  b.area::text as area, b.access::text as access, b.version, b.updated_at, b.archived_at, b.reviewer_id`;
const from = sql`from boards b left join profiles p on p.user_id = b.user_id left join auth.users u on u.id = b.user_id`;
const counts = sql`(select count(*)::int from cards c where c.board_id = y.id and c.deleted_at is null) as cards,
  (select count(*)::int from edges e join cards f on f.id = e.from_card_id and f.deleted_at is null join cards t on t.id = e.to_card_id and t.deleted_at is null where e.board_id = y.id) as edges`;
const rowOf = (r: Raw): AdminMapRow => ({
  id: r.id as string, title: r.title as string, owner: { id: r.owner_id as string, name: (r.owner_name as string | null) ?? null, email: (r.owner_email as string | null) ?? null },
  cards: Number(r.cards ?? 0), edges: Number(r.edges ?? 0), status: r.status as AdminMapRow['status'], area: r.area as AdminMapRow['area'], origin: r.origin as AdminMapRow['origin'], createdAt: dtReq(r.created_at),
});

async function listMaps(input: unknown, all?: number): Promise<Result<AdminMapPage>> {
  const q = parseWith(adminMapListQuerySchema, input);
  if (!q.ok) return q;
  const { db } = await dbm();
  const w: SQL[] = [];
  if (q.data.q) w.push(sql`(b.title ilike ${likeOf(q.data.q)} or p.name ilike ${likeOf(q.data.q)} or u.email ilike ${likeOf(q.data.q)})`);
  const f: SQL[] = [];
  if (q.data.origin) f.push(sql`origin = ${q.data.origin}`);
  if (q.data.status) f.push(sql`status = ${q.data.status}`);
  const filter = f.length ? sql`where ${sql.join(f, sql` and `)}` : sql``;
  const where = w.length ? sql`where ${sql.join(w, sql` and `)}` : sql``;
  const { page, pageSize } = q.data;
  const limit = all ?? pageSize;
  const offset = all ? 0 : (page - 1) * pageSize;
  const [rows, [t], [s]] = await Promise.all([
    db.execute(sql`with x as (select ${cols} ${from} ${where}) select y.*, ${counts} from (select * from x ${filter} order by created_at desc, id limit ${limit} offset ${offset}) y`),
    db.execute<{ n: number }>(sql`with x as (select ${cols} ${from} ${where}) select count(*)::int as n from x ${filter}`),
    db.execute<{ total: number; private: number; seed_draft: number; seed_approved: number }>(sql`with x as (select ${cols} ${from} ${where}) select count(*)::int as total,
      (count(*) filter (where status = 'private'))::int as private, (count(*) filter (where status = 'seed_draft'))::int as seed_draft,
      (count(*) filter (where status = 'seed_approved'))::int as seed_approved from x`),
  ]);
  return ok({
    items: [...rows].map((r) => rowOf(r as Raw)), total: t?.n ?? 0, page, pageSize,
    summary: { total: s?.total ?? 0, private: s?.private ?? 0, seedDraft: s?.seed_draft ?? 0, seedApproved: s?.seed_approved ?? 0 },
  });
}

// ponytail: one CSV in memory, capped; stream it if exports ever need more rows.
const EXPORT_MAX_ROWS = 10_000;
registerExport('maps', async (filters) => {
  const q = parseWith(adminMapListQuerySchema.omit({ page: true, pageSize: true }), filters);
  if (!q.ok) return q;
  const r = await listMaps(q.data, EXPORT_MAX_ROWS);
  if (!r.ok) return r;
  return ok({
    header: ['id', 'titulo', 'area', 'dono', 'email_dono', 'cards', 'conexoes', 'status', 'origem', 'criado_em'],
    rows: r.data.items.map((m) => [m.id, m.title, m.area, m.owner?.name, m.owner?.email, m.cards, m.edges, m.status, m.origin, m.createdAt]),
  });
});

async function mapOf(id: string) {
  if (!isUuid(id)) return null;
  const { db } = await dbm();
  const [r] = await db.execute(sql`with y as (select ${cols} ${from} where b.id = ${id}) select y.*, ${counts} from y`);
  return (r as Raw | undefined) ?? null;
}

type Fn = (tx: Tx, audit: AuditCapture, b: Raw) => Promise<Result<object>>;
const action = (name: AdminAction, fn: Fn) => async (c: C) => {
  const json: unknown = await c.req.json().catch(() => null);
  const id = c.req.param('id') ?? '';
  const b = await mapOf(id);
  if (!b) return notFound();
  return send(await withAdmin(c, name, { reason: reasonOf(json), target: { type: 'board', id } }, (tx, audit) => fn(tx, audit, b)));
};
const isSeed = (b: Raw) => b.origin === 'seed';

export const mapsRoutes = new Hono<AdminEnv>()
  .get('/', async (c) => send(await listMaps(c.req.query())))
  .get('/:id', async (c) => {
    const b = await mapOf(c.req.param('id'));
    if (!b) return notFound();
    return send(ok({ ...rowOf(b), area: b.area, access: b.access, version: b.version, updatedAt: dtReq(b.updated_at), archivedAt: b.archived_at ? dtReq(b.archived_at) : null, audit: await trailOf([['board', b.id as string]]) }));
  })
  // Read-only: the same loader the owner's screen uses (as the owner, RLS), no share secrets. The audit row keeps counts, never content.
  .post('/:id/open', action('map.open_readonly', async (_tx, audit, b) => {
    const g = await getBoard(b.owner_id as string, b.id as string);
    if (!g.ok) return g;
    audit.after({ cards: g.data.cards.length, edges: g.data.edges.length });
    return ok({ graph: { ...g.data, board: { ...g.data.board, shareUrl: null } } }); // the share link is a credential: never to the admin
  }))
  .post('/:id/archive', action('map.archive', async (tx, audit, b) => {
    const { boards } = await dbm();
    if (isSeed(b) || b.status === 'archived') return conflict();
    audit.before({ status: b.status });
    const rows = await tx.update(boards).set({ archivedAt: new Date() }).where(sql`${boards.id} = ${b.id as string} and ${boards.archivedAt} is null`).returning({ id: boards.id });
    if (!rows.length) return conflict();
    audit.after({ status: 'archived' });
    return ok({});
  }));

/** P-206 (D-495): a recorded review = `boards.reviewer_id` pointing at a `reviewer` profile with a name AND a valid CRM (rule 6),
 * and no live card still in draft. Without that the admin cannot make a seed public. */
async function reviewRecorded(tx: Tx, boardId: string) {
  const [r] = await tx.execute<{ name: string | null; crm: string | null; drafts: number }>(sql`select p.name, p.crm,
    (select count(*)::int from cards c where c.board_id = b.id and c.deleted_at is null and c.status <> 'approved') as drafts
    from boards b join profiles p on p.user_id = b.reviewer_id and p.role = 'reviewer' where b.id = ${boardId}`);
  return !!r?.name?.trim() && !!normalizeCrm(r.crm) && r.drafts === 0;
}

const seedAction = (name: 'seed.approve' | 'seed.unpublish', from: string, to: 'seed_approved' | 'seed_draft') =>
  action(name, async (tx, audit, b) => {
    const { boards } = await dbm();
    if (b.status !== from) return conflict();
    if (to === 'seed_approved' && !(await reviewRecorded(tx, b.id as string))) return conflict();
    audit.before({ status: b.status, reviewerId: b.reviewer_id });
    const rows = await tx.update(boards).set({ status: to, updatedAt: new Date() }).where(sql`${boards.id} = ${b.id as string} and ${boards.status} = ${from}`).returning({ id: boards.id });
    if (!rows.length) return conflict();
    audit.after({ status: to });
    return ok({});
  });

export const seedsRoutes = new Hono<AdminEnv>()
  .post('/:id/approve', seedAction('seed.approve', 'seed_draft', 'seed_approved'))
  .post('/:id/unpublish', seedAction('seed.unpublish', 'seed_approved', 'seed_draft'));
