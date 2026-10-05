// F19 FR-14 (D-460): /v1/admin/users. Every action goes through withAdmin (reason, audit, rollback). Nobody acts on themselves; an admin
// target can't be suspended or scheduled for deletion; `role` is never written here (D-430).
import { Hono, type Context } from 'hono';
import { sql } from 'drizzle-orm';
import { adminErrors, adminUserListQuerySchema, err, ok, parseWith, reasonSchema, type AdminAction, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { deleteAccount } from '../../account/account';
import { adminClient, anonClient } from '../../account/auth-admin';
import { dbm } from '../../db';
import { installedStripe } from '../../billing/stripe';
import { grantChain } from '../../billing/plan';
import { lockGrants } from '../../billing/grants';
import { accountState, notFound, reasonOf, registerExport, send, withAdmin, type AdminEnv, type AuditCapture } from '../core';
import { getUser, listUsers } from './queries';
import { isUuid } from './util';

const EXPORT_MAX_ROWS = 10_000;
const BAN_FOREVER = '876000h';
const conflict = () => err<never>('conflict', adminErrors.invalidState);
type C = Context<AdminEnv>;
type Target = NonNullable<Awaited<ReturnType<typeof accountState>>> & { id: string };
type Fn = (tx: Tx, audit: AuditCapture, t: Target, reason: string, c: C) => Promise<Result<object>>;

/** Parses the body once, resolves the target (404 without an audit row for an unknown id), refuses self-actions. */
const action = (name: AdminAction, fn: Fn, post?: (t: Target, c: C) => Promise<void>) => async (c: C) => {
  const json: unknown = await c.req.json().catch(() => null);
  const id = c.req.param('id') ?? '';
  const s = isUuid(id) ? await accountState(id) : null;
  if (!s) return notFound();
  const t = { ...s, id };
  const r = await withAdmin(c, name, { reason: reasonOf(json), target: { type: 'user', id } }, async (tx, audit) => {
    if (id === c.get('admin').id) return conflict();
    return fn(tx, audit, t, reasonSchema.parse(reasonOf(json)), c);
  });
  if (r.ok && post) await post(t, c);
  return send(r);
};

registerExport('users', async (filters, tx) => {
  const q = parseWith(adminUserListQuerySchema.omit({ page: true, pageSize: true }), filters);
  if (!q.ok) return q;
  const { items } = await listUsers(q.data, tx, { all: EXPORT_MAX_ROWS });
  return ok({
    header: ['id', 'nome', 'email', 'plano', 'mapas', 'cards', 'status', 'origem', 'criado_em', 'grantUntil'],
    rows: items.map((u) => [u.id, u.name, u.email, u.plan, u.maps, u.cards, u.status, u.origin, u.createdAt, u.grantUntil]),
  });
});

const snapshot = (t: Target) => ({ status: t.deletedAt ? 'deleting' : t.suspendedAt ? 'suspended' : 'active' });

export const usersRoutes = new Hono<AdminEnv>()
  .get('/', async (c) => {
    const q = parseWith(adminUserListQuerySchema, c.req.query());
    return send(q.ok ? ok(await listUsers(q.data)) : q);
  })
  .get('/:id', async (c) => {
    const u = isUuid(c.req.param('id')) ? await getUser(c.req.param('id')) : null;
    return u ? send(ok(u)) : notFound();
  })
  // 1 month of Pro, source 'support', chained behind the user's running grants like F18's (starts_at = greatest(now, end of chain)).
  .post('/:id/grant-pro-month', action('user.grant_pro_month', async (tx, audit, t) => {
    if (t.deletedAt) return conflict();
    const { entitlementGrants: g } = await dbm();
    await lockGrants(tx, t.id);
    const now = new Date();
    const chain = await grantChain(t.id, now, tx);
    const startsAt = chain.until && chain.until > now ? chain.until : now;
    audit.before({ proUntil: chain.until });
    const [row] = await tx.insert(g).values({ userId: t.id, source: 'support', startsAt, endsAt: sql`${startsAt.toISOString()}::timestamptz + interval '1 month'` }).returning();
    audit.after({ grantId: row!.id, startsAt: row!.startsAt, endsAt: row!.endsAt });
    return ok({});
  }))
  // The e-mail leaves inside the action: a failure rolls the audit row back into `denied/error`. Never returns a link or a password.
  .post('/:id/password-reset', action('user.password_reset', async (_tx, audit, t, _r, c) => {
    if (t.deletedAt || !t.email) return conflict();
    const { error } = await anonClient().auth.resetPasswordForEmail(t.email, { redirectTo: `${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/entrar` });
    if (error) {
      c.get('log').error('admin password reset failed', { code: error.code ?? error.status });
      return err('internal', 'password reset not sent');
    }
    audit.after({ sent: true });
    return ok({});
  }))
  // DB first (blocks every /v1 call at once, D-447); after commit: Auth ban + sessions deleted. A failure there is logged, the DB already blocks.
  .post('/:id/suspend', action('user.suspend', async (tx, audit, t, reason) => {
    const { profiles } = await dbm();
    if (t.role === 'admin' || t.suspendedAt) return conflict();
    audit.before(snapshot(t));
    const rows = await tx.update(profiles).set({ suspendedAt: new Date(), suspendedReason: reason }).where(sql`${profiles.userId} = ${t.id} and ${profiles.suspendedAt} is null`).returning({ id: profiles.userId });
    if (!rows.length) return conflict();
    audit.after({ status: 'suspended' });
    return ok({});
  }, async (t, c) => {
    try {
      const { db } = await dbm();
      await adminClient().auth.admin.updateUserById(t.id, { ban_duration: BAN_FOREVER });
      await db.execute(sql`delete from auth.sessions where user_id = ${t.id}`);
    } catch (e) {
      c.get('log').error('admin suspend: ban/sessions failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }))
  // Unban first (idempotent, inside): if the commit then fails the user stays suspended in the DB, the safe side.
  .post('/:id/reactivate', action('user.reactivate', async (tx, audit, t, _r, c) => {
    const { profiles } = await dbm();
    if (!t.suspendedAt) return conflict();
    audit.before(snapshot(t));
    const { error } = await adminClient().auth.admin.updateUserById(t.id, { ban_duration: 'none' });
    if (error) {
      c.get('log').error('admin reactivate: unban failed', { code: error.code ?? error.status });
      return err('internal', 'unban failed');
    }
    // Guarded like suspend: two concurrent reactivations = one success row, the other invalid_state.
    const rows = await tx.update(profiles).set({ suspendedAt: null, suspendedReason: null }).where(sql`${profiles.userId} = ${t.id} and ${profiles.suspendedAt} is not null`).returning({ id: profiles.userId });
    if (!rows.length) return conflict();
    audit.after({ status: 'active' });
    return ok({});
  }))
  // Exactly the user's own flow (F13/D-104): Stripe cancel first, then deleted_at; hard delete after RETENTION.deletionGraceDays by the maintenance job.
  // ponytail: deleteAccount uses its own connection, so a crash between it and the audit insert loses the audit row (not the other way around).
  .post('/:id/schedule-deletion', action('user.schedule_deletion', async (_tx, audit, t) => {
    if (t.role === 'admin' || t.deletedAt) return conflict();
    audit.before(snapshot(t));
    const r = await deleteAccount(t.id, installedStripe());
    if (!r.ok) return r;
    audit.after({ status: 'deleting', hardDeleteAt: r.data.hardDeleteAt });
    return ok({ hardDeleteAt: r.data.hardDeleteAt });
  }));
