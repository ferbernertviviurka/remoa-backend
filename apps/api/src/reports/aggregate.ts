import type { FsrsMemory, ProgressSummary } from '@remoa/contracts';
import { retrievability } from '@remoa/fsrs';

export type AttemptFact = { day: string; grade: number; area: 'CM'; matrixItemId: string | null; matrixTitle?: string | null };
export type AttemptBucket = { day: string; attempts: number; hits: number; area: 'CM'; matrixItemId: string | null; matrixTitle?: string | null };
export type WeakFact = { cardId: string; boardId: string; title: string; r: number };

/** Same recall as the map. A card that was never reviewed is not weak, even though its recall is 0. */
export function weakFromMemory(rows: { cardId: string; boardId: string; title: string; memory: FsrsMemory }[], now: Date): WeakFact[] {
  return rows.flatMap((row) => {
    if (row.memory.reps === 0 || !row.memory.lastReview) return [];
    const r = retrievability(row.memory, now);
    if (!(r < 0.7)) return [];
    return [{ cardId: row.cardId, boardId: row.boardId, title: row.title, r }];
  });
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const ratioOf = (n: number, hits: number) => (n ? hits / n : null);

/** Retention, daily counts, streak and accuracy. Grade 3 or 4 counts as a hit. One pass, so 50k attempts stay under the report budget. `studiedDays` may reach further back than the 30-day window so a long streak is not cut off. */
export function summarize(attempts: AttemptFact[], weak: WeakFact[], today: string, studiedDays?: Iterable<string>): ProgressSummary {
  const from7 = addDays(today, -6);
  const from30 = addDays(today, -29);
  const dayCounts = new Map<string, number>();
  for (let i = 0; i < 30; i++) dayCounts.set(addDays(from30, i), 0);
  let n7 = 0;
  let hit7 = 0;
  let n30 = 0;
  let hit30 = 0;
  const days = new Set<string>(studiedDays);
  const buckets = new Map<string, { attempts: number; correct: number; label: string | null; matrixItemId: string | null }>();
  for (const a of attempts) {
    days.add(a.day);
    if (a.day < from30 || a.day > today) continue;
    n30 += 1;
    const hit = a.grade >= 3;
    if (hit) hit30 += 1;
    if (a.day >= from7) {
      n7 += 1;
      if (hit) hit7 += 1;
    }
    if (dayCounts.has(a.day)) dayCounts.set(a.day, (dayCounts.get(a.day) ?? 0) + 1);
    bump(buckets, a.matrixItemId, a.matrixTitle, 1, hit ? 1 : 0);
  }
  return finish(n7, hit7, n30, hit30, dayCounts, days, buckets, weak, today);
}

/** Same report as `summarize`, from rows already counted in the database. */
export function summarizeBuckets(rows: AttemptBucket[], weak: WeakFact[], today: string, studiedDays?: Iterable<string>): ProgressSummary {
  const from7 = addDays(today, -6);
  const from30 = addDays(today, -29);
  const dayCounts = new Map<string, number>();
  for (let i = 0; i < 30; i++) dayCounts.set(addDays(from30, i), 0);
  let n7 = 0;
  let hit7 = 0;
  let n30 = 0;
  let hit30 = 0;
  const days = new Set<string>(studiedDays);
  const buckets = new Map<string, { attempts: number; correct: number; label: string | null; matrixItemId: string | null }>();
  for (const a of rows) {
    days.add(a.day);
    if (a.day < from30 || a.day > today) continue;
    n30 += a.attempts;
    hit30 += a.hits;
    if (a.day >= from7) {
      n7 += a.attempts;
      hit7 += a.hits;
    }
    if (dayCounts.has(a.day)) dayCounts.set(a.day, (dayCounts.get(a.day) ?? 0) + a.attempts);
    bump(buckets, a.matrixItemId, a.matrixTitle, a.attempts, a.hits);
  }
  return finish(n7, hit7, n30, hit30, dayCounts, days, buckets, weak, today);
}

/** Area total plus one row per matrix item. The area row counts every attempt in the window. */
function bump(
  buckets: Map<string, { attempts: number; correct: number; label: string | null; matrixItemId: string | null }>,
  matrixItemId: string | null,
  matrixTitle: string | null | undefined,
  attempts: number,
  hits: number,
) {
  const area = buckets.get('area:CM') ?? { attempts: 0, correct: 0, label: null, matrixItemId: null };
  area.attempts += attempts;
  area.correct += hits;
  buckets.set('area:CM', area);
  if (!matrixItemId) return;
  const item = buckets.get(matrixItemId) ?? { attempts: 0, correct: 0, label: matrixTitle ?? null, matrixItemId };
  item.attempts += attempts;
  item.correct += hits;
  if (!item.label && matrixTitle) item.label = matrixTitle;
  buckets.set(matrixItemId, item);
}

function finish(
  n7: number,
  hit7: number,
  n30: number,
  hit30: number,
  dayCounts: Map<string, number>,
  days: Set<string>,
  buckets: Map<string, { attempts: number; correct: number; label: string | null; matrixItemId: string | null }>,
  weak: WeakFact[],
  today: string,
): ProgressSummary {
  let streakDays = 0;
  for (let d = days.has(today) ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) streakDays += 1;
  const reviewsPerDay = [...dayCounts.entries()].map(([date, count]) => ({ date, count }));
  const accuracy = [...buckets.values()].map((b) => ({
    area: 'CM' as const,
    matrixItemId: b.matrixItemId,
    label: b.matrixItemId ? b.label : null,
    attempts: b.attempts,
    correct: b.correct,
    accuracy: ratioOf(b.attempts, b.correct),
  }));
  return {
    retention7d: ratioOf(n7, hit7),
    retention30d: ratioOf(n30, hit30),
    reviewsPerDay,
    streakDays,
    weakCards: weak.filter((w) => w.r < 0.7).sort((a, b) => a.r - b.r).slice(0, 20),
    accuracy,
  };
}
