// G28-P / F35 (CCR-160): health-area reference data from seed/reference/*.json (content lane). Idempotent upsert by code /
// e-MEC code; never deletes (profiles point at institutions). Missing files are skipped, so the loader runs before content lands.
import { existsSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { normalizeSearch, referenceSeedSchemas as files, type ReferenceSeed as Files } from '@remoa/contracts';
import type { Db } from '../client';
import { councils, healthCourses, institutions, studyGoals } from '../schema';

export const REFERENCE_DIR = new URL('../../seed/reference/', import.meta.url);

/** Parsed and validated against the contract codes; a file that is not there yet is undefined. */
export function readReference(dir: URL = REFERENCE_DIR): Partial<Files> {
  const out: Partial<Files> = {};
  for (const k of Object.keys(files) as (keyof Files)[]) {
    const f = new URL(`${k}.json`, dir);
    if (existsSync(f)) (out as Record<string, unknown>)[k] = files[k].parse(JSON.parse(readFileSync(f, 'utf8')));
  }
  return out;
}

const ex = (col: string) => sql.raw(`excluded.${col}`);

export async function seedReference(db: Pick<Db, 'insert'>, ref: Partial<Files> = readReference()) {
  if (ref.councils?.length) {
    await db.insert(councils).values(ref.councils).onConflictDoUpdate({ target: councils.code, set: { name: ex('name') } });
  }
  if (ref['health-courses']?.length) {
    await db.insert(healthCourses).values(ref['health-courses']).onConflictDoUpdate({
      target: healthCourses.code,
      set: { name: ex('name'), aliases: ex('aliases'), kind: ex('kind'), councilCode: ex('council_code'), suggestedGoals: ex('suggested_goals'), sort: ex('sort') },
    });
  }
  if (ref['study-goals']?.length) {
    await db.insert(studyGoals).values(ref['study-goals'].map((g, sort) => ({ ...g, sort })))
      .onConflictDoUpdate({ target: studyGoals.code, set: { name: ex('name'), courseCodes: ex('course_codes'), sort: ex('sort') } });
  }
  const inst = ref.institutions ?? [];
  for (let i = 0; i < inst.length; i += 500) {
    const rows = inst.slice(i, i + 500).map((r) => ({ ...r, search: normalizeSearch([r.name, r.acronym ?? '', r.city].join(' ')) }));
    await db.insert(institutions).values(rows).onConflictDoUpdate({
      target: institutions.emecCode,
      set: { name: ex('name'), acronym: ex('acronym'), city: ex('city'), uf: ex('uf'), type: ex('type'), search: ex('search'), updatedAt: sql`now()` },
    });
  }
  return { councils: ref.councils?.length ?? 0, courses: ref['health-courses']?.length ?? 0, goals: ref['study-goals']?.length ?? 0, institutions: inst.length };
}
