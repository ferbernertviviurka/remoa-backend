import { eq } from 'drizzle-orm';
import {
  DEFAULT_PREFERENCES, PLAN_LIMITS, effectiveNewCardsPerDay, err, ok, reminderHourSchema, themes,
  type Preferences, type UpdatePreferences,
} from '@remoa/contracts';
import { dbm } from '../db';
import { planOf } from '../billing/plan';

type Row = { theme: string; reduceMotion: boolean | null; reminderEnabled: boolean; reminderHour: number; newCardsPerDay: number | null; emailReviewReminders: boolean; emailProductNews: boolean };

const toPrefs = (r: Row | undefined, cap: number | null): Preferences => ({
  theme: themes.find((t) => t === r?.theme) ?? DEFAULT_PREFERENCES.theme,
  reduceMotion: r?.reduceMotion ?? DEFAULT_PREFERENCES.reduceMotion,
  reminderEnabled: r?.reminderEnabled ?? DEFAULT_PREFERENCES.reminderEnabled,
  reminderHour: reminderHourSchema.safeParse(r?.reminderHour).data ?? DEFAULT_PREFERENCES.reminderHour,
  newCardsPerDay: effectiveNewCardsPerDay(r?.newCardsPerDay ?? null, cap),
  emailReviewReminders: r?.emailReviewReminders ?? DEFAULT_PREFERENCES.emailReviewReminders,
  emailProductNews: r?.emailProductNews ?? DEFAULT_PREFERENCES.emailProductNews,
});

export async function getPreferences(userId: string, planCap: number | null): Promise<Preferences> {
  const { db, userPreferences: t } = await dbm();
  const [r] = await db.select().from(t).where(eq(t.userId, userId));
  return toPrefs(r, planCap);
}

/** FR-13 / D-122: upsert; the Free plan above its cap is `forbidden` 'pro_required' (the UI shows the Pro notice). */
export const updatePreferences: UpdatePreferences = async (userId, input) => {
  const cap = PLAN_LIMITS[(await planOf(userId)).plan].newCardsPerDay;
  if (cap !== null && input.newCardsPerDay != null && input.newCardsPerDay > cap) return err('forbidden', 'pro_required'); // null = follow the plan
  const { db, userPreferences: t } = await dbm();
  const [r] = await db.insert(t).values({ userId, ...input }).onConflictDoUpdate({ target: t.userId, set: { ...input, updatedAt: new Date() } }).returning();
  return ok(toPrefs(r, cap));
};
