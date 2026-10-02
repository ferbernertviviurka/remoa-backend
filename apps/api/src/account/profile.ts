import { eq, sql } from 'drizzle-orm';
import {
  RETENTION, computeCompleteness, err, goalSchema, normalizeName, ok, stageSchema,
  type AccountSnapshot, type CancelDeletion, type LinkedIdentity, type Profile, type UpdateProfile,
} from '@remoa/contracts';
import { dbm, run } from '../db';
import { dayWindow } from '../review/queue';
import { getEntitlements } from '../billing/entitlements';
import { signAvatarUrls } from './avatar';
import { getPreferences } from './preferences';
import { recordEvent } from './events';

const DAY = 86_400_000;
const DEFAULT_TZ = 'America/Sao_Paulo';

type AuthData = { email: string; emailConfirmed: boolean; pendingEmail: string | null; identities: LinkedIdentity[]; joinedAt: Date };

const profileOf = (userId: string, r: { name: string | null; avatarKey: string | null; avatarColor: number; goal: string | null; stage: string | null; timezone: string } | undefined): Profile => ({
  userId,
  name: r?.name ?? null,
  avatarKey: r?.avatarKey ?? null,
  avatarColor: r?.avatarColor ?? 0,
  goal: goalSchema.safeParse(r?.goal).data ?? null, // onboarding slugs outside goalSchema -> null (D-126)
  stage: stageSchema.safeParse(r?.stage).data ?? null,
  timezone: r?.timezone ?? DEFAULT_TZ,
});

/** Consecutive study days (04:00 rollover, profile tz) with attempts, ending today or yesterday. null = never answered. */
async function streakOf(userId: string, now: Date): Promise<number | null> {
  return run(userId, async (tx) => {
    const win = await dayWindow(tx, userId, now);
    const rows = await tx.execute<{ d: string }>(sql`
      select distinct ((created_at at time zone ${win.tz}::text) - interval '4 hours')::date::text as d
      from attempts where user_id = ${userId} order by d desc limit 400`);
    if (!rows.length) return null;
    const have = new Set(rows.map((r) => r.d));
    const prev = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
    let day = have.has(win.day) ? win.day : prev(win.day); // not having studied yet today does not break the streak
    let n = 0;
    while (have.has(day)) {
      n++;
      day = prev(day);
    }
    return n;
  });
}

/** Uses the (user_id, type, created_at) index of account_events. */
async function passwordChangedAt(userId: string): Promise<Date | null> {
  const { db, accountEvents } = await dbm();
  const [r] = await db
    .select({ at: sql<Date | null>`max(${accountEvents.createdAt})` })
    .from(accountEvents)
    .where(sql`${accountEvents.userId} = ${userId} and ${accountEvents.type} = 'password_changed'`);
  return r?.at ? new Date(r.at) : null;
}

/** FR-3 snapshot. Auth data (e-mail, pending e-mail, identities) comes from Supabase Admin, see `loadAuthUser`. */
export async function getAccount(userId: string, auth: AuthData, now = new Date()): Promise<AccountSnapshot> {
  const { db, profiles } = await dbm();
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId));
  const ent = await getEntitlements(userId, now);
  if (!ent.ok) throw new Error(ent.error.message);
  const profile = profileOf(userId, row);
  const preferences = await getPreferences(userId, ent.data.newCardsPerDay);
  return {
    profile,
    email: auth.email,
    pendingEmail: auth.pendingEmail,
    emailConfirmed: auth.emailConfirmed,
    identities: auth.identities,
    preferences,
    entitlements: ent.data,
    completeness: computeCompleteness(profile, preferences, { emailConfirmed: auth.emailConfirmed, emailPending: !!auth.pendingEmail }),
    streakDays: await streakOf(userId, now),
    joinedAt: auth.joinedAt,
    deletionScheduledFor: row?.deletedAt ? new Date(row.deletedAt.getTime() + RETENTION.deletionGraceDays * DAY) : null,
    passwordChangedAt: await passwordChangedAt(userId),
    avatarUrls: profile.avatarKey ? await signAvatarUrls(profile.avatarKey) : null,
  };
}

/** FR-6/FR-8. `name` is already normalized by the contract schema; normalized again so direct callers are safe too. */
export const updateProfile: UpdateProfile = async (userId, input) => {
  const set = { ...input, ...(input.name !== undefined && { name: normalizeName(input.name) }), updatedAt: new Date() };
  const { db, profiles } = await dbm();
  const [row] = await db.insert(profiles).values({ userId, ...set }).onConflictDoUpdate({ target: profiles.userId, set }).returning();
  return ok(profileOf(userId, row));
};

/** D-123: only inside the grace period; the purge job deletes after it. */
export const cancelDeletion: CancelDeletion = async (userId) => {
  const { db, profiles } = await dbm();
  const [r] = await db.select({ d: profiles.deletedAt }).from(profiles).where(eq(profiles.userId, userId));
  if (!r?.d) return err('conflict', 'no deletion scheduled');
  if (Date.now() >= r.d.getTime() + RETENTION.deletionGraceDays * DAY) return err('forbidden', 'grace period over');
  await db.update(profiles).set({ deletedAt: null }).where(eq(profiles.userId, userId));
  await recordEvent(db, userId, 'deletion_canceled');
  return ok(null);
};
