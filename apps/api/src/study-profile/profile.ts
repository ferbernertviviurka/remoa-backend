// G28-P / F35: study profile ("Seu estudo"). Owner-only rows through run() (RLS); reference tables are public data.
import { eq, getTableColumns, sql } from 'drizzle-orm';
import {
  err, ok, profileCapabilities, studyProfileInputSchema,
  type HealthCourse, type ProfileCapabilities, type Result, type StudyGoalCode, type StudyProfile, type StudyProfileInputParsed, type StudyProfileSource,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { invalidate } from '../cache';
import { dbm, run } from '../db';

export type StudyProfileView = { profile: StudyProfile | null; capabilities: ProfileCapabilities };

/** One owner read: the row, its institution and its course (for suggestedGoals). Used by GET and by GET /v1/account/me. */
export async function readStudyProfile(tx: Tx, userId: string): Promise<StudyProfileView> {
  const s = await dbm();
  const sp = s.studyProfiles;
  const [r] = await tx.select({ sp: getTableColumns(sp), inst: getTableColumns(s.institutions) }).from(sp)
    .leftJoin(s.institutions, eq(sp.institutionId, s.institutions.id)).where(eq(sp.userId, userId));
  if (!r) return { profile: null, capabilities: profileCapabilities(null) };
  const [course] = r.sp.courseCode ? await tx.select({ suggestedGoals: s.healthCourses.suggestedGoals }).from(s.healthCourses).where(eq(s.healthCourses.code, r.sp.courseCode)) : [];
  const p = r.sp;
  const profile: StudyProfile = {
    situation: p.situation as StudyProfile['situation'],
    course: p.courseCode as StudyProfile['course'],
    courseOtherText: p.courseOtherText,
    institution: r.inst && { id: r.inst.id, name: r.inst.name, acronym: r.inst.acronym, city: r.inst.city, uf: r.inst.uf as StudyProfile['uf'] & string, type: r.inst.type as 'public' | 'private' },
    institutionText: p.institutionText,
    city: p.city,
    uf: p.uf as StudyProfile['uf'],
    institutionType: p.institutionType as StudyProfile['institutionType'],
    period: p.period,
    goals: p.goals as StudyGoalCode[],
    customGoals: p.customGoals,
    councilNumber: p.councilNumber,
    nonHealthTopic: p.nonHealthTopic,
    source: p.source as StudyProfileSource,
    updatedAt: p.updatedAt,
  };
  return { profile, capabilities: profileCapabilities(profile, course as Pick<HealthCourse, 'suggestedGoals'> | undefined) };
}

/**
 * Upsert from validated input. Server rules: institutionId overwrites city/uf/type (and drops institutionText); the council number
 * is kept only for a profissional in a course with a council. `ifAbsent` = never overwrite an existing row (signup metadata).
 */
async function save(userId: string, i: StudyProfileInputParsed, source: StudyProfileSource, ifAbsent = false): Promise<Result<null>> {
  return run(userId, async (tx, s) => {
    const [inst] = i.institutionId ? await tx.select().from(s.institutions).where(eq(s.institutions.id, i.institutionId)) : [];
    if (i.institutionId && !inst) return err<null>('validation', 'unknown institution');
    const [course] = await tx.select({ councilCode: s.healthCourses.councilCode }).from(s.healthCourses).where(eq(s.healthCourses.code, i.course));
    const v = {
      situation: i.situation,
      courseCode: i.course,
      courseOtherText: i.courseOtherText ?? null,
      institutionId: inst?.id ?? null,
      institutionText: inst ? null : (i.institutionText ?? null),
      city: inst ? inst.city : (i.city ?? null),
      uf: inst ? inst.uf : (i.uf ?? null),
      institutionType: inst ? inst.type : (i.institutionType ?? null),
      period: i.period ?? null,
      goals: i.goals,
      customGoals: i.customGoals,
      councilNumber: course?.councilCode && i.situation === 'profissional' ? (i.councilNumber ?? null) : null,
      nonHealthTopic: i.nonHealthTopic ?? null,
      source,
    };
    const q = tx.insert(s.studyProfiles).values({ userId, ...v });
    await (ifAbsent ? q.onConflictDoNothing() : q.onConflictDoUpdate({ target: s.studyProfiles.userId, set: { ...v, updatedAt: sql`now()` } }));
    return ok(null);
  });
}

/**
 * Sign-up step 2 rides in auth metadata (D-1859). Invalid or absent = ignored. Idempotent: the first writer wins.
 * D-1862: metadata is copied into the user's JWT, so the council number is never taken from it, and the key is removed once
 * adopted (same direct auth.users write as identities.ts); later tokens no longer carry the study profile.
 */
async function adoptSignupMetadata(userId: string): Promise<void> {
  const { db } = await dbm();
  const rows = await db.execute<{ sp: unknown }>(sql`select raw_user_meta_data -> 'study_profile' as sp from auth.users where id = ${userId}`);
  if (rows[0]?.sp == null) return;
  const parsed = studyProfileInputSchema.safeParse(rows[0].sp);
  if (parsed.success && (await save(userId, { ...parsed.data, councilNumber: null }, 'signup', true)).ok) await invalidate('profile.changed', { userId });
  await db.execute(sql`update auth.users set raw_user_meta_data = raw_user_meta_data - 'study_profile' where id = ${userId}`);
}

export async function getStudyProfile(userId: string): Promise<Result<StudyProfileView>> {
  let v = await run(userId, (tx) => readStudyProfile(tx, userId));
  if (!v.profile) {
    await adoptSignupMetadata(userId);
    v = await run(userId, (tx) => readStudyProfile(tx, userId));
  }
  return ok(v);
}

/** PUT and POST /confirm: the same write; the row becomes source 'profile' (a migration row is confirmed this way). */
export async function putStudyProfile(userId: string, input: StudyProfileInputParsed): Promise<Result<StudyProfileView>> {
  const w = await save(userId, input, 'profile');
  if (!w.ok) return w;
  await invalidate('profile.changed', { userId }); // after the commit; the profile tag feeds the Conta/Hoje reads
  return ok(await run(userId, (tx) => readStudyProfile(tx, userId)));
}

// FR-6: in-memory limiter per user (ponytail: one API instance, move to Redis with the other limiters).
const hits = new Map<string, number[]>();
export const SUGGESTION_LIMIT = { max: 20, windowMs: 3_600_000 };
export function takeSuggestionSlot(userId: string, now = Date.now()): boolean {
  for (const [k, v] of hits) if (v.every((t) => now - t >= SUGGESTION_LIMIT.windowMs)) hits.delete(k);
  const list = (hits.get(userId) ?? []).filter((t) => now - t < SUGGESTION_LIMIT.windowMs);
  if (list.length >= SUGGESTION_LIMIT.max) return (hits.set(userId, list), false);
  hits.set(userId, [...list, now]);
  return true;
}

/** Upsert by (kind, normalized text), count + 1. The author is not stored. Server connection (table has no grants for clients). */
export async function suggestReference(kind: string, text: string, normalized: string): Promise<void> {
  const { db, referenceSuggestions: t } = await dbm();
  await db.insert(t).values({ kind, text, normalized }).onConflictDoUpdate({ target: [t.kind, t.normalized], set: { count: sql`${t.count} + 1`, lastSeenAt: sql`now()` } });
}
