/** Scoped campaign caller. The server route is the authority; this client never selects rows or sends IDs/time. */
import { pathToFileURL } from 'node:url';

export const CAMPAIGN_ID = 'F27-editorial-20d';
export const ENDPOINT = 'https://backend.remoa.com.br/v1/cron/blog.campaign-2026-10';
export const START_AT = Date.parse('2026-10-09T12:00:00.000Z');
export const EXPIRES_AT = Date.parse('2026-10-29T06:00:00.000Z');
export const SECRET_ENV = 'BLOG_CAMPAIGN_2026_10_SECRET';

/** No network access in the default mode; this is safe to run before configuration/deployment. */
export function plan(now = Date.now()) {
  return {
    campaignId: CAMPAIGN_ID,
    mode: 'dry-run',
    endpoint: ENDPOINT,
    method: 'POST',
    body: 'none',
    query: 'none',
    credentialName: SECRET_ENV,
    credentialScope: 'dedicated campaign route; not admin JWT, CRON_SECRET or service-role',
    startsAt: new Date(START_AT).toISOString(),
    expiresAt: new Date(EXPIRES_AT).toISOString(),
    localState: now < START_AT ? 'not-started' : now >= EXPIRES_AT ? 'expired' : 'within-window',
    requires: 'reviewed/deployed dedicated route + authenticated enrollment of exactly 20 real posts and cover assets',
    noProductionChanges: true,
  };
}

export async function run({ now = Date.now(), secret, fetchImpl = globalThis.fetch } = {}) {
  if (!Number.isFinite(now)) throw new Error('Invalid clock');
  if (now < START_AT || now >= EXPIRES_AT) return { campaignId: CAMPAIGN_ID, status: 'outside-window', published: 0 };
  if (typeof secret !== 'string' || secret.length < 32 || /[\r\n]/.test(secret)) throw new Error('Dedicated campaign secret missing/invalid');
  let response;
  try {
    // Exact allowlisted URL: no redirects, override URL, path interpolation, query, IDs or request body.
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    // An uncertain request is never retried by this process. Server idempotence protects the next normal cron run.
    throw new Error('Campaign request outcome unknown; no retry performed');
  }
  if (!response.ok) throw new Error(`Campaign endpoint HTTP ${response.status}; response body not logged`);
  let json;
  try { json = await response.json(); } catch { throw new Error('Campaign response invalid; outcome unknown; no retry performed'); }
  const d = json?.data;
  if (json?.ok !== true || d?.campaignId !== CAMPAIGN_ID || !Number.isInteger(d?.published) || d.published < 0 || d.published > 20) {
    throw new Error('Campaign response violates reviewed contract; outcome unknown; no retry performed');
  }
  return { campaignId: CAMPAIGN_ID, status: 'completed', published: d.published };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2);
  if (flags.some(f => f !== '--execute')) throw new Error('Only --execute is accepted; endpoint and campaign cannot be overridden');
  if (!flags.includes('--execute')) {
    console.log(JSON.stringify(plan()));
  } else {
    try {
      // This container needs only its dedicated scoped secret. Reject privileged broad-job credentials if misconfigured.
      for (const name of ['CRON_SECRET', 'DATABASE_URL', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE_KEY', 'BLOG_ADMIN_ACCESS_TOKEN']) {
        if (process.env[name]) throw new Error(`Unexpected broad credential ${name}; configure campaign-only variables`);
      }
      console.log(JSON.stringify(await run({ secret: process.env[SECRET_ENV] })));
    } catch (e) {
      console.error(JSON.stringify({ campaignId: CAMPAIGN_ID, status: 'failed', error: e instanceof Error ? e.message : 'Campaign run failed' }));
      process.exitCode = 1;
    }
  }
}
