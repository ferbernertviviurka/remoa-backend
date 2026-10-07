import { createHash } from 'node:crypto';
import { cardRubricServerSchema, type CardRubricServer } from '@remoa/contracts';

/** sha256 of the card fields a rubric is tied to (D-1610: cards have no version column). */
export function cardContentHash(front: string | null, back: string | null, porQue: string | null): string {
  return createHash('sha256').update(`${front ?? ''}\n${back ?? ''}\n${porQue ?? ''}`, 'utf8').digest('hex');
}

/** When no stored rubric matches the hash, the expected answer's sentences are the essential points. Critical errors stay empty. */
export function rubricFromAnswer(expected: string): CardRubricServer | null {
  const parts = expected
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim().slice(0, 400))
    .filter((s) => s.length >= 3)
    .slice(0, 12);
  const essentialPoints = parts.length ? parts : [expected.trim().slice(0, 400)].filter(Boolean);
  const parsed = cardRubricServerSchema.safeParse({ essentialPoints, acceptedVariants: [], criticalErrors: [], status: 'auto' });
  return parsed.success ? parsed.data : null;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** FR-17: a suggested topic counts only when it is exactly a code or a name from the closed taxonomy. */
export function matchClosedTopic(suggested: string | null | undefined, topics: readonly { id: string; code: string; name: string }[]): string | null {
  const n = fold(suggested ?? '');
  if (!n) return null;
  return topics.find((t) => fold(t.code) === n || fold(t.name) === n)?.id ?? null;
}
