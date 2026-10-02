// F17 T3: owner side of sharing. Share columns are written only by the server connection after the owner check (D-288).
import { and, eq, sql } from 'drizzle-orm';
import { err, idSchema, ok, type GetShare, type ShareState, type UpdateShare } from '@remoa/contracts';
import { dbm } from '../db';
import { hashSharePassword, newShareToken } from '../share/crypto';
import { shareUrlOf } from '../share/url';

const notFound = () => err<never>('not_found', 'board not found');

async function ownedShare(userId: string, boardId: string) {
  if (!idSchema.safeParse(boardId).success) return null;
  const { db, boards: b } = await dbm();
  const [row] = await db
    .select({
      status: b.status, archivedAt: b.archivedAt, access: b.access, shareToken: b.shareToken, sharePasswordHash: b.sharePasswordHash,
      shareSecretVersion: b.shareSecretVersion, sharedAt: b.sharedAt, copyCount: b.copyCount,
    })
    .from(b)
    .where(and(eq(b.id, boardId), eq(b.userId, userId)));
  return row ?? null;
}

const toState = (r: { access: ShareState['access']; shareToken: string | null; copyCount: number }): ShareState => ({
  access: r.access, url: shareUrlOf(r.shareToken), copies: r.copyCount,
});

export const getShare: GetShare = async (userId, boardId) => {
  const row = await ownedShare(userId, boardId);
  return row ? ok(toState(row)) : notFound();
};

export const updateShare: UpdateShare = async (userId, boardId, input) => {
  const cur = await ownedShare(userId, boardId);
  if (!cur) return notFound();
  if (input.access !== 'owner' && cur.archivedAt) return err('validation', 'archived board cannot be shared');
  if (input.access !== 'owner' && cur.status !== 'private') return err('validation', 'only student boards can be shared');
  if (input.access === 'password' && input.password === undefined && !cur.sharePasswordHash) return err('validation', 'password: required for access=password');

  const changed = input.access !== cur.access || input.password !== undefined || !!input.rotate;
  if (!changed) return ok(toState(cur));
  const linked = input.access !== 'owner';
  const next = {
    access: input.access,
    shareToken: linked ? (input.rotate || !cur.shareToken ? newShareToken() : cur.shareToken) : null,
    sharePasswordHash: input.access === 'password' ? (input.password !== undefined ? await hashSharePassword(input.password) : cur.sharePasswordHash) : null,
    sharedAt: linked ? (cur.sharedAt ?? new Date()) : null,
    shareSecretVersion: cur.shareSecretVersion + 1,
  };
  const { db, boards: b } = await dbm();
  // Compare-and-set on the version: a concurrent change wins once, the other gets `conflict` instead of a silent overwrite.
  const [row] = await db
    .update(b)
    .set(next)
    .where(and(eq(b.id, boardId), eq(b.userId, userId), eq(b.shareSecretVersion, cur.shareSecretVersion)))
    .returning({ access: b.access, shareToken: b.shareToken, copyCount: b.copyCount });
  return row ? ok(toState(row)) : err('conflict', 'share changed concurrently');
};

/** Archiving turns the link off and goes back to "Só eu"; unarchiving does not turn it back on. Returns the updated row, or null if nothing changed. */
export async function turnOffShare(userId: string, boardId: string) {
  const { db, boards: b } = await dbm();
  const [row] = await db
    .update(b)
    .set({ access: 'owner', shareToken: null, sharePasswordHash: null, sharedAt: null, shareSecretVersion: sql`${b.shareSecretVersion} + 1` })
    .where(and(eq(b.id, boardId), eq(b.userId, userId), sql`${b.access} <> 'owner'`))
    .returning();
  return row ?? null;
}
