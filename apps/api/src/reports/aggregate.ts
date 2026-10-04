import type { ProgressSummary } from '@remoa/contracts';

export type AttemptFact = { day: string; grade: number; area: 'CM'; matrixItemId: string | null; matrixTitle?: string | null };
export type AttemptBucket = { day: string; attempts: number; hits: number; area: 'CM'; matrixItemId: string | null; matrixTitle?: string | null };
export type WeakFact = { cardId: string; boardId: string; title: string; r: number };

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
    const key = a.matrixItemId ?? `area:${a.area}`;
    const bucket = buckets.get(key) ?? { attempts: 0, correct: 0, label: a.matrixTitle ?? null, matrixItemId: a.matrixItemId };
    bucket.attempts += 1;
    if (hit) bucket.correct += 1;
    if (!bucket.label && a.matrixTitle) bucket.label = a.matrixTitle;
    buckets.set(key, bucket);
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
    const key = a.matrixItemId ?? `area:${a.area}`;
    const bucket = buckets.get(key) ?? { attempts: 0, correct: 0, label: a.matrixTitle ?? null, matrixItemId: a.matrixItemId };
    bucket.attempts += a.attempts;
    bucket.correct += a.hits;
    if (!bucket.label && a.matrixTitle) bucket.label = a.matrixTitle;
    buckets.set(key, bucket);
  }
  return finish(n7, hit7, n30, hit30, dayCounts, days, buckets, weak, today);
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
