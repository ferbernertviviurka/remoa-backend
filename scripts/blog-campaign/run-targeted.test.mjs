import test from 'node:test';
import assert from 'node:assert/strict';
import { run, plan, ENDPOINT, CAMPAIGN_ID, START_AT, EXPIRES_AT } from './run-targeted.mjs';

const now = Date.parse('2026-10-10T12:05:00Z');
const secret = 'test-only-campaign-secret-with-32-chars';
const response = (published = 1) => new Response(JSON.stringify({ ok: true, data: { campaignId: CAMPAIGN_ID, published } }), { status: 200 });

test('default plan is offline and fixed to campaign endpoint', () => {
  assert.equal(plan(now).mode, 'dry-run');
  assert.equal(plan(now).endpoint, ENDPOINT);
  assert.equal(plan(now).body, 'none');
  assert.equal(plan(now).noProductionChanges, true);
});
test('outside window exits without credential or request', async () => {
  let calls = 0;
  for (const instant of [START_AT - 1, EXPIRES_AT, EXPIRES_AT + 1]) {
    const r = await run({ now: instant, fetchImpl: async () => { calls++; throw new Error('must not request'); } });
    assert.equal(r.status, 'outside-window');
  }
  assert.equal(calls, 0);
});
test('invalid secrets and clock never request', async () => {
  let calls = 0;
  for (const value of [undefined, '', 'too-short', `${secret}\n`]) {
    await assert.rejects(run({ now, secret: value, fetchImpl: async () => { calls++; return response(); } }), /secret/);
  }
  await assert.rejects(run({ now: NaN, secret }), /clock/);
  assert.equal(calls, 0);
});
test('request carries no body, query, IDs or time and cannot redirect', async () => {
  const result = await run({ now, secret, fetchImpl: async (url, init) => {
    assert.equal(url, ENDPOINT);
    assert.equal(new URL(url).search, '');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.authorization, `Bearer ${secret}`);
    assert.deepEqual(Object.keys(init.headers).sort(), ['accept', 'authorization']);
    return response(1);
  } });
  assert.deepEqual(result, { campaignId: CAMPAIGN_ID, status: 'completed', published: 1 });
});
test('server no-op is accepted', async () => {
  assert.equal((await run({ now, secret, fetchImpl: async () => response(0) })).published, 0);
});
test('HTTP denial is fail closed without printing potentially sensitive body', async () => {
  await assert.rejects(run({ now, secret, fetchImpl: async () => new Response('private-error-detail', { status: 401 }) }), e => /401/.test(e.message) && !e.message.includes('private'));
});
test('ambiguous transport performs exactly one attempt', async () => {
  let calls = 0;
  await assert.rejects(run({ now, secret, fetchImpl: async () => { calls++; throw new Error(secret); } }), e => /unknown/.test(e.message) && !e.message.includes(secret));
  assert.equal(calls, 1);
});
test('malformed success and different campaign are rejected', async () => {
  for (const body of ['not json', JSON.stringify({ok:true,data:{campaignId:'another',published:1}}), JSON.stringify({ok:false,data:{campaignId:CAMPAIGN_ID,published:1}})]) {
    await assert.rejects(run({ now, secret, fetchImpl: async () => new Response(body) }), /invalid|contract/);
  }
});
test('impossible counts are rejected, never treated as success', async () => {
  for (const count of [-1,21,1.5,'1',null]) await assert.rejects(run({ now, secret, fetchImpl: async () => response(count) }), /contract/);
});
