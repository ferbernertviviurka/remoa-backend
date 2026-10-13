/** F34 FR-18 (CCR-148): resolving/dismissing a report sends one in-app notice to the reporter, after the COMMIT. Isolated f33_test DB only. */
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeToken, fakeVerifier } from '../../admin/core/test-helpers';
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => {}) }));
const url = process.env.DATABASE_URL;
if (url && !new URL(url).pathname.includes('f33_test')) throw Error('isolated f33_test required');
describe.skipIf(!url)('FR-18 report resolution notice', () => {
  const admin = uuid(), reporter = uuid(), muted = uuid(), bystander = uuid(), q = uuid(), users = [admin, reporter, muted, bystander];
  const reports = { resolved: uuid(), dismissed: uuid(), muted: uuid() };
  let db: typeof import('@remoa/db').db.$client, app: ReturnType<typeof import('../../app').createApp>;
  const call = async (path: string, body: unknown) => {
    const r = await app.request('/v1' + path, { method: 'POST', headers: { authorization: 'Bearer ' + fakeToken(admin, 60_000), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as { data?: { report: { updatedAt: string } } } };
  };
  const resolve = (id: string, status: string, updatedAt: string) => call(`/admin/questions/reports/${id}/resolve`, { status, reason: 'Synthetic resolution reason', expectedUpdatedAt: updatedAt });
  const stamp = async (id: string) => String((await db`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t FROM question_reports WHERE id=${id}`)[0]!.t);
  const notices = async (user: string) => await db`SELECT data,href FROM notifications WHERE user_id=${user} AND type='question_report_resolved'`;
  beforeAll(async () => {
    db = (await import('@remoa/db')).db.$client;
    for (const id of users) await db`INSERT INTO auth.users(id,email) VALUES(${id},${id + '@fr18.example'})`;
    await db`UPDATE profiles SET role='admin' WHERE user_id=${admin}`;
    await db`INSERT INTO question_bank(id,user_id,visibility,origin,type,difficulty,stem,expected_answer,source) VALUES(${q},${null},'public','official_exam','discursive','medium','Synthetic public question','x','ai')`;
    for (const [key, user] of [['resolved', reporter], ['dismissed', reporter], ['muted', muted]] as const)
      await db`INSERT INTO question_reports(id,user_id,question_id,version,type,description) VALUES(${reports[key]},${user},${q},1,'key','Synthetic report')`;
    await db`INSERT INTO notification_preferences(user_id,key,in_app,email) VALUES(${muted},'support',false,true)`;
    const { createApp } = await import('../../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: fakeVerifier(users) });
  });
  afterAll(async () => {
    await db`DELETE FROM question_reports WHERE question_id=${q}`; await db`DELETE FROM question_bank WHERE id=${q}`;
    await db`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`; await db.end({ timeout: 1 });
  });
  it('resolved: one notice to the reporter, idempotent on retry, none for others, no sensitive data', async () => {
    const at = await stamp(reports.resolved);
    expect((await resolve(reports.resolved, 'open', at)).status).toBe(200); // unchanged (already open): nothing sent
    expect(await notices(reporter)).toHaveLength(0);
    expect((await resolve(reports.resolved, 'resolved', at)).status).toBe(200);
    expect((await resolve(reports.resolved, 'resolved', at)).status).toBe(200); // replay: changed=false
    const rows = await notices(reporter);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ href: '/app/banco-de-questoes', data: { questionId: q, reportId: reports.resolved, outcome: 'resolved' } });
    expect(JSON.stringify(rows)).not.toMatch(/correctKey|explanation|crm|reviewer|description/i);
    expect(await notices(bystander)).toHaveLength(0); expect(await notices(admin)).toHaveLength(0);
  });
  it('dismissed notifies once more; reopening notifies nobody; muted reporter gets no row', async () => {
    const at = await stamp(reports.dismissed);
    expect((await resolve(reports.dismissed, 'dismissed', at)).status).toBe(200);
    expect((await notices(reporter)).map((r) => (r.data as { outcome: string }).outcome).sort()).toEqual(['dismissed', 'resolved']);
    expect((await resolve(reports.dismissed, 'open', await stamp(reports.dismissed))).status).toBe(200);
    expect(await notices(reporter)).toHaveLength(2);
    expect((await resolve(reports.muted, 'resolved', await stamp(reports.muted))).status).toBe(200);
    expect(await notices(muted)).toHaveLength(0);
  });
});
