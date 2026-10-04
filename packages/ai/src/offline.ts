import type { GraderInput, GraderVerdict } from '@remoa/contracts';

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const hit = (answer: string, text: string) =>
  norm(text)
    .split(/\W+/)
    .some((w) => w.length >= 5 && answer.includes(w));

const blank = (answer: string) => /nao sei|nao lembro|nao faco ideia/.test(answer);

/** Drug, dose or conduct that contradicts a noradrenaline rubric. */
const contrary = (answer: string, rubricText: string) =>
  /noradrenalina/.test(rubricText) && /dopamina|10\s*mg|adrenalina\b/.test(answer) && !/noradrenalina/.test(answer);

/**
 * Rubric-only grader used when OpenRouter has no key, and as the eval baseline.
 * "Não sei" is incorrect. A clinically plausible answer that misses the rubric is partial.
 */
export function gradeOffline(input: GraderInput): GraderVerdict {
  const answer = norm(input.answer);
  const rubricText = norm(input.rubric.points.map((p) => p.text).join(' '));
  if (blank(answer)) {
    return {
      verdict: 'incorrect',
      matched: [],
      missing: input.rubric.points.map((p) => p.text),
      criticalError: false,
      feedback: 'Sem resposta para corrigir contra a rubrica.',
      model: 'offline-grader',
    };
  }
  const criticalError = contrary(answer, rubricText);
  const matched = input.rubric.points.filter((p) => hit(answer, p.text));
  const missing = input.rubric.points.filter((p) => !hit(answer, p.text));
  const essentialMissing = missing.some((p) => p.essential);
  const verdict = criticalError ? 'incorrect' : matched.length === 0 ? 'partial' : essentialMissing ? 'partial' : 'correct';
  return {
    verdict,
    matched: matched.map((p) => p.text),
    missing: missing.map((p) => p.text),
    criticalError,
    feedback: criticalError
      ? 'A conduta contraria a rubrica.'
      : verdict === 'correct'
        ? 'A resposta cobre os pontos essenciais da rubrica.'
        : 'Faltaram pontos da rubrica. O que não está nela não entra como acerto.',
    model: 'offline-grader',
  };
}
