// G28-P / F35 FR-6/FR-15: public reference data (courses, goals, institutions). No user data, so no RLS context: server connection.
import { and, asc, eq, sql } from 'drizzle-orm';
import { ok, normalizeSearch, type HealthCourse, type Institution, type InstitutionsQuery, type Result, type StudyGoal } from '@remoa/contracts';
import { dbm } from '../db';

export async function listCourses(): Promise<Result<HealthCourse[]>> {
  const { db, healthCourses: c } = await dbm();
  const rows = await db.select().from(c).orderBy(asc(c.sort), asc(c.code));
  return ok(rows.map((r) => ({ code: r.code, name: r.name, aliases: r.aliases, kind: r.kind, councilCode: r.councilCode, suggestedGoals: r.suggestedGoals }) as HealthCourse));
}

export async function listGoals(course?: string): Promise<Result<StudyGoal[]>> {
  const { db, studyGoals: g } = await dbm();
  const rows = await db.select().from(g).where(course ? sql`${g.courseCodes} is null or ${course} = any(${g.courseCodes})` : undefined).orderBy(asc(g.sort), asc(g.code));
  return ok(rows.map((r) => ({ code: r.code, name: r.name, courseCodes: r.courseCodes }) as StudyGoal));
}

/** Matches on `search` (GIN trigram). Order: exact acronym, then prefix of the name, then the rest by name. */
export async function searchInstitutions({ q, uf, limit }: InstitutionsQuery): Promise<Result<Institution[]>> {
  const { db, institutions: i } = await dbm();
  const n = normalizeSearch(q);
  const esc = n.replace(/[\\%_]/g, '\\$&');
  const rows = await db.select({ id: i.id, name: i.name, acronym: i.acronym, city: i.city, uf: i.uf, type: i.type }).from(i)
    .where(and(sql`${i.search} like ${`%${esc}%`}`, uf ? eq(i.uf, uf) : undefined))
    .orderBy(
      sql`(lower(coalesce(${i.acronym}, '')) = ${n}) desc`,
      sql`(${i.search} like ${`${esc}%`}) desc`,
      asc(i.name), asc(i.id),
    )
    .limit(limit);
  return ok(rows as Institution[]);
}
