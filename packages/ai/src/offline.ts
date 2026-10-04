import type { GraderInput, GraderVerdict } from '@remoa/contracts';

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const wordsOf = (text: string) => norm(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 5);

const hasWord = (text: string, word: string) => new RegExp(`(?:^|[^a-z])${word}(?:[^a-z]|$)`).test(text);

/** A point counts only when every meaningful word is present, not when one shared verb is. */
const hit = (answer: string, text: string) => {
  const words = wordsOf(text);
  if (!words.length) return answer.includes(norm(text).trim());
  return words.every((w) => hasWord(answer, w));
};

const blank = (answer: string) => /nao sei|nao lembro|nao faco ideia/.test(answer);

const DRUGS = ['noradrenalina', 'dopamina', 'adrenalina', 'vasopressina', 'dobutamina'] as const;

/** Same route under either name counts as the one the rubric already allows. */
const ROUTE_WORDS = [
  ['bolus', 'bolus'],
  ['intramuscular', 'intramuscular'],
  ['intravenosa', 'venosa'],
  ['endovenosa', 'venosa'],
  ['subcutanea', 'subcutanea'],
] as const;

const dosesOf = (text: string) => new Set((text.match(/\d+\s*mg\b/g) ?? []).map((dose) => dose.replace(/\s+/g, '')));

const routesOf = (text: string) => {
  const found = new Set<string>();
  for (const [word, id] of ROUTE_WORDS) if (hasWord(text, word)) found.add(id);
  return found;
};

/**
 * Conduct the rubric does not contain: a listed drug it never names, a milligram dose it never states,
 * or a route it never states. Naming the drug the rubric asks for does not hide an extra dose or route.
 */
const contrary = (answer: string, rubricText: string) => {
  const rubricDrugs = DRUGS.filter((drug) => hasWord(rubricText, drug));
  const answerDrugs = DRUGS.filter((drug) => hasWord(answer, drug));
  const drugOutside = answerDrugs.some((drug) => !hasWord(rubricText, drug)) && rubricDrugs.every((drug) => !hasWord(answer, drug));
  const inventedDose = [...dosesOf(answer)].some((dose) => !dosesOf(rubricText).has(dose));
  const routeOutside = [...routesOf(answer)].some((route) => !routesOf(rubricText).has(route));
  return drugOutside || inventedDose || routeOutside;
};

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
