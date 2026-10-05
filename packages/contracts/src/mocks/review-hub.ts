// G15 mock: the numbers of the Revisar canvas (Free plan, 2 maps). `reviewHubFixture('done' | 'empty' | 'no_history')` for the other states.
import { ok } from '../errors';
import type { GetReviewHub } from '../api';
import { REVIEW_HUB_DEFAULT_SECONDS_PER_CARD, activityLevel, type ReviewHub } from '../review-hub';
import type { QueueItem } from '../review';
import { FIXTURE_NOW, fid } from './fixtures';

const DAY = 86_400_000;
const day = (offset: number) => new Date(FIXTURE_NOW.getTime() + offset * DAY).toISOString().slice(0, 10);
const MAPS = [
  { boardId: fid(100), title: 'Sepse', cards: 6, states: { review: 2, watch: 2, steady: 1, unknown: 1 }, due: 2, new: 1, weak: 2, retention30: 0.84 },
  { boardId: fid(101), title: 'Insuficiência cardíaca', cards: 38, states: { review: 5, watch: 9, steady: 20, unknown: 4 }, due: 5, new: 4, weak: 9, retention30: 0.88 },
].map((m) => ({ ...m, area: 'CM' as const }));

const items = (): ReviewHub['queue']['items'] => {
  let n = 1000;
  return MAPS.flatMap((m) =>
    (['due', 'new', 'weak'] as const).flatMap((reason) =>
      Array.from({ length: m[reason] }, (): QueueItem & { mode: 'hidden_card' } => ({ cardId: fid(n++), boardId: m.boardId, subId: null, reason, mode: 'hidden_card' })),
    ),
  );
};

export const reviewHubFixture = (status: ReviewHub['status'] = 'active'): ReviewHub => {
  const empty = status === 'empty';
  const noHistory = status === 'no_history';
  const done = status === 'done';
  const maps = empty ? [] : MAPS.map((m) => (done ? { ...m, due: 0, new: 0, weak: 0 } : m));
  const queueItems = empty || done ? [] : items();
  const counts = { due: queueItems.filter((i) => i.reason === 'due').length, new: queueItems.filter((i) => i.reason === 'new').length, weak: queueItems.filter((i) => i.reason === 'weak').length };
  const defaultCount = counts.due + counts.new;
  const hist = empty || noHistory ? 0 : 1;
  const forecastBase = [0, 12, 14, 6, 9, 11, 8, 5, 10, 13, 7, 9, 12, 6];
  const states = empty ? { review: 0, watch: 0, steady: 0, unknown: 0 } : { review: 7, watch: 11, steady: 21, unknown: 5 };
  const cardsTotal = states.review + states.watch + states.steady + states.unknown;
  const retention = (n: number, step: number) =>
    Array.from({ length: n }, (_, i) => ({ date: day(-(n - 1 - i) * step), value: hist ? Math.min(0.99, 0.84 + 0.02 * Math.sin(i / 3.4) + (i / n) * 0.03) : null }));
  const activity = Array.from({ length: 105 }, (_, i) => {
    const offset = i - 98 - 3; // FIXTURE_NOW is a Thursday: 3 days after Monday of the last week
    const count = offset > 0 || !hist ? 0 : (i * 37 + 11) % 11 < 3 ? 0 : ((i * 37 + 11) % 11) * 2;
    return { date: day(offset), count, level: activityLevel(count), future: offset > 0 };
  });
  return {
    status,
    generatedAt: FIXTURE_NOW,
    today: { day: day(0), reviewed: hist ? 3 : 0 },
    queue: {
      items: queueItems,
      counts,
      defaultCount,
      newLimit: 10,
      newRemaining: empty || done ? 0 : 10,
      secondsPerCard: REVIEW_HUB_DEFAULT_SECONDS_PER_CARD,
      estimatedSeconds: defaultCount * REVIEW_HUB_DEFAULT_SECONDS_PER_CARD,
      dueTomorrow: empty ? 0 : 12,
      aheadCount: empty ? 0 : 26,
    },
    kpis: {
      streak: hist * 12,
      bestStreak: hist * 21,
      weekDots: [true, true, true, true, false, false, false].map((d) => d && !!hist),
      retention30: hist ? 0.87 : null,
      retentionDelta: hist ? 3 : null,
      reviews7: hist * 119,
      firm: states.steady,
      firmTotal: cardsTotal,
      firmPct: cardsTotal ? Math.round((states.steady / cardsTotal) * 100) : 0,
    },
    forecast: forecastBase.map((count, i) => ({ date: day(i), count: empty ? 0 : i === 0 ? counts.due : count })),
    states,
    retention: { d7: retention(7, 1), d30: retention(30, 1), d90: retention(30, 3) },
    activity,
    areas: (['CM', 'CIR', 'GO', 'PED', 'MP'] as const).map((area) => ({ area, cards: area === 'CM' && !empty ? 44 : 0, dueToday: area === 'CM' ? counts.due : 0, attempts: area === 'CM' ? hist * 119 : 0, accuracy: area === 'CM' && hist ? 0.86 : null })),
    hardCards: empty || noHistory
      ? []
      : [
          { cardId: fid(2000), boardId: fid(100), boardTitle: 'Sepse', title: 'Critérios de sepse (qSOFA e SOFA)', r: 0.52, lapses: 4 },
          { cardId: fid(2001), boardId: fid(101), boardTitle: 'Insuficiência cardíaca', title: 'Classificação funcional da NYHA', r: 0.58, lapses: 3 },
        ],
    maps,
  };
};

export const getReviewHub: GetReviewHub = async () => ok(reviewHubFixture());
