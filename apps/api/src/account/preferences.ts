import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_PREFERENCES, PLAN_LIMITS, effectivePref, effectiveNewCardsPerDay, err, ok, reminderHourSchema, themes,
  type Preferences, type UpdatePreferences,
} from '@remoa/contracts';
import { dbm } from '../db';
import { planOf } from '../billing/plan';
import { setPref } from '../notifications/service';
import { invalidate } from '../cache';

type Row = { theme: string; reduceMotion: boolean | null; reminderEnabled: boolean; reminderHour: number; newCardsPerDay: number | null; emailReviewReminders: boolean; emailProductNews: boolean };

/** P-301 (D-743): the review reminder e-mail lives in notification_preferences 'review_reminder'; the two old booleans both read it. */
const reminderEmail = async (userId: string) => {
  const { db, notificationPreferences: n } = await dbm();
  const [row] = await db.select({ inApp: n.inApp, email: n.email }).from(n).where(and(eq(n.userId, userId), eq(n.key, 'review_reminder')));
  return effectivePref('review_reminder', row ?? null).email;
};

const toPrefs = (r: Row | undefined, cap: number | null, reminder: boolean): Preferences => ({
  theme: themes.find((t) => t === r?.theme) ?? DEFAULT_PREFERENCES.theme,
  reduceMotion: r?.reduceMotion ?? DEFAULT_PREFERENCES.reduceMotion,
  reminderEnabled: reminder,
  reminderHour: reminderHourSchema.safeParse(r?.reminderHour).data ?? DEFAULT_PREFERENCES.reminderHour,
  newCardsPerDay: effectiveNewCardsPerDay(r?.newCardsPerDay ?? null, cap),
  emailReviewReminders: reminder,
  emailProductNews: r?.emailProductNews ?? DEFAULT_PREFERENCES.emailProductNews,
});

export async function getPreferences(userId: string, planCap: number | null): Promise<Preferences> {
  const { db, userPreferences: t } = await dbm();
  const [r] = await db.select().from(t).where(eq(t.userId, userId));
  return toPrefs(r, planCap, await reminderEmail(userId));
}

/** FR-13 / D-122: upsert; the Free plan above its cap is `forbidden` 'pro_required' (the UI shows the Pro notice). */
export const updatePreferences: UpdatePreferences = async (userId, input) => {
  const cap = PLAN_LIMITS[(await planOf(userId)).plan].newCardsPerDay;
  if (cap !== null && input.newCardsPerDay != null && input.newCardsPerDay > cap) return err('forbidden', 'pro_required'); // null = follow the plan
  const { db, userPreferences: t } = await dbm();
  // Either old flag set => the reminder e-mail; both set => both must be on (the old rule). Legacy columns are mirrored for jobs that still read them.
  const wanted = input.reminderEnabled !== undefined && input.emailReviewReminders !== undefined ? input.reminderEnabled && input.emailReviewReminders : (input.reminderEnabled ?? input.emailReviewReminders);
  if (wanted !== undefined) {
    await setPref(userId, 'review_reminder', 'email', wanted);
    input = { ...input, reminderEnabled: wanted, emailReviewReminders: wanted };
  }
  const [r] = await db.insert(t).values({ userId, ...input }).onConflictDoUpdate({ target: t.userId, set: { ...input, updatedAt: new Date() } }).returning();
  await invalidate('prefs.changed', { userId });
  return ok(toPrefs(r, cap, await reminderEmail(userId)));
};
