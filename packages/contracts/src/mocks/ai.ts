// Deterministic F05 mocks (no network, < 50 ms).
import { err, ok } from '../errors';
import type { BoardGenerationProgress } from '../ai';
import type { GenerateBoard, GenerateRubric, GetGenerationProgress, GradeAnswer } from '../api';
import { fid, sepseBoardId } from './fixtures';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** A rubric point counts as matched when any of its words with ≥ 5 letters appears in the answer. */
export const grade: GradeAnswer = async ({ rubric, answer }) => {
  const a = norm(answer);
  const hit = (text: string) => norm(text).split(/\W+/).some((w) => w.length >= 5 && a.includes(w));
  const matched = rubric.points.filter((p) => hit(p.text));
  const missing = rubric.points.filter((p) => !hit(p.text));
  const essentialMissing = missing.some((p) => p.essential);
  const verdict = matched.length === 0 ? 'incorrect' : essentialMissing ? 'partial' : 'correct';
  return ok({
    verdict,
    matched: matched.map((p) => p.text),
    missing: missing.map((p) => p.text),
    criticalError: false,
    feedback: verdict === 'correct' ? 'Resposta cobre os pontos essenciais.' : 'Faltaram pontos da rubrica.',
    model: 'mock-grader',
  });
};

export const generateRubric: GenerateRubric = async (card, source) => {
  const text = card.back ?? card.title;
  const points = text
    .split(/[.;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) => ({ text: t, essential: true }));
  return ok({ points, source, version: 1, status: 'draft', reviewerId: null });
};

const jobs = new Map<string, BoardGenerationProgress>();
export const resetAiMocks = () => jobs.clear();

/** Jobs complete instantly and point at the Sepse fixture board. */
export const generateBoard: GenerateBoard = async () => {
  const jobId = fid(9000 + jobs.size);
  jobs.set(jobId, { jobId, status: 'done', progress: 100, stage: null, boardId: sepseBoardId, error: null });
  return ok({ jobId });
};

export const getGenerationProgress: GetGenerationProgress = async (_userId, jobId) => {
  const job = jobs.get(jobId);
  return job ? ok(job) : err('not_found', 'job not found');
};
