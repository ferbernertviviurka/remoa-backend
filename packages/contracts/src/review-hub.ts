import { z } from 'zod';
import { areas } from './enums';
import { idSchema, probabilitySchema, timestampSchema } from './common';
import { queueItemSchema } from './review';

/**
 * G15 / F21 "Revisar" (D-640): one aggregate for the whole page, `GET /v1/review/hub`.
 * Computed on read from `fsrs_state`, `attempts` and the F03 queue rule (same source as the rail badge and Hoje); no `review_daily` table.
 * "Day" = profile time zone, rolling over at 04:00 (F03; Q-035).
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nat = z.number().int().nonnegative();

/** Q-032 (provisional): per-card time when the user has no history. Otherwise the median `duration_ms` of the last attempts. */
export const REVIEW_HUB_DEFAULT_SECONDS_PER_CARD = 27;
export const REVIEW_HUB_FORECAST_DAYS = 14;
export const REVIEW_HUB_ACTIVITY_WEEKS = 15;
/** "Adiantar revisões" (Q-034): cards due in at most this many days after today. */
export const REVIEW_HUB_AHEAD_DAYS = 2;
export const REVIEW_HUB_HARD_CARDS_MAX = 10;
/** Q-035 / FR-12: activity cell level by reviews in the day: 0 = none, then <= 5, <= 10, <= 20, more. */
export const activityLevel = (count: number): 0 | 1 | 2 | 3 | 4 => (count <= 0 ? 0 : count <= 5 ? 1 : count <= 10 ? 2 : count <= 20 ? 3 : 4);

/**
 * `empty` = no cards at all; `no_history` = cards but never reviewed (queue may still have new cards; charts show a message);
 * `done` = history and the default queue is empty; `active` = default queue > 0.
 */
export const reviewHubStatuses = ['empty', 'no_history', 'done', 'active'] as const;

export const hubMapSchema = z.object({
  boardId: idSchema,
  title: z.string(),
  area: z.enum(areas),
  cards: nat,
  /** Card-level counts (same rule as the map); they add up to `cards`. */
  states: z.object({ review: nat, watch: nat, steady: nat, unknown: nat }),
  /** Queue contribution of the board: due items, new items (already capped by what is left of today's limit) and "em atenção" items. */
  due: nat,
  new: nat,
  weak: nat,
  /** correct ÷ attempts in the last 30 days; null without attempts. */
  retention30: probabilitySchema.nullable(),
});
export type HubMap = z.infer<typeof hubMapSchema>;

const retentionPointSchema = z.object({ date: isoDate, value: probabilitySchema.nullable() });

export const reviewHubSchema = z.object({
  status: z.enum(reviewHubStatuses),
  generatedAt: timestampSchema,
  /** Study day (YYYY-MM-DD) and items rated in it (ring = reviewed ÷ (reviewed + defaultCount)). */
  today: z.object({ day: isoDate, reviewed: nat }),
  queue: z.object({
    /**
     * Every candidate item in queue order (due by recall asc, new, weak by recall asc). `new` is capped per board at `newRemaining`.
     * Client-side filter by chip (`reason`) and board, with no new request: keep the items of the chosen boards, take the first
     * `newRemaining` of the `new` ones, then count. The server applies the same rule when the session starts with `filter`.
     */
    items: z.array(queueItemSchema.required({ mode: true })),
    /** Default queue (Q-033): due + new up to the limit; "em atenção" is optional. */
    counts: z.object({ due: nat, new: nat, weak: nat }),
    defaultCount: nat,
    /** Plan cap (10 Free, 20 Pro; F08) lowered by the user's preference (F13), and what is left of it today. */
    /** null = unlimited (D-647). */
    newLimit: nat.nullable(),
    newRemaining: nat.nullable(),
    /** Q-032: user's median seconds per card (27 without history). Estimated time of any selection = count × this. */
    secondsPerCard: z.number().positive(),
    estimatedSeconds: nat,
    /** Items due on the next study day, and items due within REVIEW_HUB_AHEAD_DAYS (the "Adiantar revisões" selection). */
    dueTomorrow: nat,
    aheadCount: nat,
  }),
  kpis: z.object({
    streak: nat,
    bestStreak: nat,
    /** Monday first; true = at least one review that day; future days are false. */
    weekDots: z.array(z.boolean()).length(7),
    retention30: probabilitySchema.nullable(),
    /** retention30 minus the retention of the 30 days before, in percentage points (null if either is missing). */
    retentionDelta: z.number().nullable(),
    reviews7: nat,
    /** Cards whose recall is >= 0.85 (state `steady`) ÷ cards. */
    firm: nat,
    firmTotal: nat,
    firmPct: nat.max(100),
  }),
  /** Exactly 14 days from today (index 0 = today, including overdue). Items by their current `due`, no simulated answers. */
  forecast: z.array(z.object({ date: isoDate, count: nat })).length(REVIEW_HUB_FORECAST_DAYS),
  /** Card-level counts, aligned with the map states. Add up to the number of cards. */
  states: z.object({ review: nat, watch: nat, steady: nat, unknown: nat }),
  /** Hit rate per point (grade >= 3). `d7`/`d30` = one point per day, oldest first; `d90` = 30 points of 3 days each (date = last day of the bucket). */
  retention: z.object({ d7: z.array(retentionPointSchema).length(7), d30: z.array(retentionPointSchema).length(30), d90: z.array(retentionPointSchema).length(30) }),
  /** 15 weeks x 7 days = 105 cells, Monday first, oldest first; the last week contains today. */
  activity: z.array(z.object({ date: isoDate, count: nat, level: z.number().int().min(0).max(4), future: z.boolean() })).length(REVIEW_HUB_ACTIVITY_WEEKS * 7),
  /** One row per area (`areas`), accuracy over the last 30 days; `cards` = 0 means "Criar mapa". The client sorts weakest first. */
  areas: z.array(z.object({ area: z.enum(areas), cards: nat, dueToday: nat, attempts: nat, accuracy: probabilitySchema.nullable() })),
  /** Most lapses first, then lowest recall; at most REVIEW_HUB_HARD_CARDS_MAX (the screen shows 4). Only cards with `lapses` > 0. */
  hardCards: z.array(z.object({ cardId: idSchema, boardId: idSchema, boardTitle: z.string(), title: z.string(), r: probabilitySchema, lapses: z.number().int().positive() })).max(REVIEW_HUB_HARD_CARDS_MAX),
  maps: z.array(hubMapSchema),
});
export type ReviewHub = z.infer<typeof reviewHubSchema>;
