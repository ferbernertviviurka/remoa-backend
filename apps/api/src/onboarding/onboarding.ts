import { sql } from 'drizzle-orm';
import { ACTIVATION_TARGETS, activationItems, ok, onboardingAnswersSchema, type ActivationItem, type GetOnboarding, type CompleteOnboarding, type OnboardingAnswersPatch, type OnboardingState, type SaveOnboarding } from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { sendEmail } from '../account/mailer';
import { welcomeEmail } from './email-copy';

const log = createLogger({ requestId: 'onboarding' });
const web = () => process.env.WEB_ORIGIN ?? 'http://localhost:3000';

type Row = { done_at: string | null; answers: Record<string, unknown>; cards: number; edges: number; sessions: number };

/** One query per read: profile row + FR-9 counts over live, non-archived boards (D-524). */
async function load(userId: string): Promise<OnboardingState> {
  const { db } = await dbm();
  const [r] = await db.execute<Row>(sql`
    select p.onboarding_done_at as done_at, p.onboarding_answers as answers,
      (select count(*)::int from cards c join boards b on b.id = c.board_id where b.user_id = ${userId} and b.archived_at is null and c.deleted_at is null and c.type <> 'note') as cards,
      (select count(*)::int from edges e join boards b on b.id = e.board_id where b.user_id = ${userId} and b.archived_at is null) as edges,
      (select count(*)::int from sessions s where s.user_id = ${userId} and s.ended_at is not null) as sessions
    from profiles p where p.user_id = ${userId}`);
  const counts = { cards: r?.cards ?? 0, edges: r?.edges ?? 0, sessions: r?.sessions ?? 0 };
  const checklist: ActivationItem[] = activationItems.map((id) => ({ id, current: counts[id], target: ACTIVATION_TARGETS[id], done: counts[id] >= ACTIVATION_TARGETS[id] }));
  return {
    doneAt: r?.done_at ? new Date(r.done_at) : null,
    answers: onboardingAnswersSchema.partial().parse(r?.answers ?? {}), // strips server-only keys like `_emails`
    checklist,
  };
}

export const getOnboarding: GetOnboarding = async (userId) => ok(await load(userId));

/** Marks `_emails.<key>` atomically; true only for the caller that set it (D-525: at-most-once, a failed send is logged, not retried). */
export async function claimEmail(userId: string, key: 'welcome' | 'mapReady' | 'day3'): Promise<boolean> {
  const { db } = await dbm();
  const r = await db.execute(sql`
    update profiles set onboarding_answers = jsonb_set(onboarding_answers, '{_emails}', coalesce(onboarding_answers->'_emails', '{}'::jsonb) || jsonb_build_object(${key}::text, now()))
    where user_id = ${userId} and deleted_at is null and not (coalesce(onboarding_answers->'_emails', '{}'::jsonb) ? ${key}::text)`);
  return r.count > 0;
}

export const saveOnboarding: SaveOnboarding = async (userId, patch: OnboardingAnswersPatch) => {
  const { db } = await dbm();
  // CCR-017 (D-570): goals (multi) win over the legacy single goal; goal mirrors goals[0].
  const goals = patch.goals ?? (patch.goal ? [patch.goal] : null);
  // Server connection: goal/goals/stage have no client GRANT. `||` merges and keeps `_emails`.
  await db.execute(sql`
    update profiles set onboarding_answers = onboarding_answers || ${JSON.stringify(patch)}::jsonb,
      goal = coalesce(${goals?.[0] ?? null}::text, goal), stage = coalesce(${patch.segment ?? null}::text, stage),
      goals = case when ${goals ? JSON.stringify(goals) : null}::jsonb is null then goals
        else array(select jsonb_array_elements_text(${JSON.stringify(goals ?? [])}::jsonb)) end
    where user_id = ${userId}`);
  try {
    if (await claimEmail(userId, 'welcome')) {
      const [u] = await db.execute<{ email: string | null; name: string | null }>(sql`select u.email, p.name from auth.users u join profiles p on p.user_id = u.id where u.id = ${userId}`);
      if (u?.email) await sendEmail({ to: u.email, ...welcomeEmail({ name: u.name?.split(' ')[0] ?? 'estudante', url: `${web()}/app` }) });
    }
  } catch (e) {
    log.error('welcome email failed', { userId, error: e instanceof Error ? e.message : String(e) });
  }
  return ok(await load(userId));
};

export const completeOnboarding: CompleteOnboarding = async (userId) => {
  const { db } = await dbm();
  await db.execute(sql`
    update profiles set onboarding_done_at = now() where user_id = ${userId} and onboarding_done_at is null`);
  return ok(await load(userId));
};
