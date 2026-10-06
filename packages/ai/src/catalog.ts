// G22 (D-1407): boot check of the configured models and key. Never throws and never blocks boot: problems go to the log and to
// `/health` (`ai` block, no secret). Free models leave the catalog without notice, so this runs on every boot and in `ai:doctor`.
import { createLogger } from '@remoa/log';
import { aiConfig, aiMode, chainFor, missingConfig, type AiFn } from './config';
import { headers, refusal, rememberPrice } from './client';

/** Parameters each function sends (see grade.ts / extract.ts). */
export const PARAMS_BY_FN: Record<string, readonly string[]> = {
  grader: ['response_format'], // JSON mode since grader/v4 (D-1438)
  rubric: ['response_format'],
  extract: ['response_format'],
};

export type CatalogModel = {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
  context_length?: number;
};

export type KeyInfo = { isFreeTier: boolean | null; usageDaily: number | null; limit: number | null; limitRemaining: number | null };

export type AiHealth = {
  status: 'ok' | 'degraded' | 'off' | 'mock' | 'pending';
  model: string | null;
  fallbacks: string[];
  problems: string[];
  key: KeyInfo | null;
  checkedAt: string | null;
};

let health: AiHealth = { status: 'pending', model: null, fallbacks: [], problems: [], key: null, checkedAt: null };

/** Last boot check, for `/health`. Model ids, problem texts and key tier only. */
export const aiHealth = (): AiHealth => (aiMode() === 'live' ? health : { ...health, status: aiMode() as 'off' | 'mock', problems: aiMode() === 'off' ? missingConfig().map((v) => `missing ${v}`) : [] });

const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Problems of one model against what the app needs. Empty = usable. */
export function modelProblems(id: string, m: CatalogModel | undefined, params: readonly string[], requireFree: boolean): string[] {
  if (!m) return [`${id}: not in the catalog`];
  const out: string[] = [];
  const prompt = num(m.pricing?.prompt) ?? 0;
  const completion = num(m.pricing?.completion) ?? 0;
  if (requireFree && (prompt !== 0 || completion !== 0)) out.push(`${id}: price is not zero`);
  const input = m.architecture?.input_modalities ?? [];
  // "Text only" is the free-model test rule (G22); a paid production model only has to take text (we never send anything else).
  if (requireFree && input.some((x) => x !== 'text')) out.push(`${id}: accepts ${input.join('+')}, not text only`);
  if (input.length && !input.includes('text')) out.push(`${id}: does not accept text`);
  const supported = m.supported_parameters ?? [];
  const missing = params.filter((p) => !supported.includes(p));
  if (missing.length) out.push(`${id}: does not support ${missing.join(', ')}`);
  return out;
}

async function getJson<T>(path: string, fetchImpl: typeof fetch): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const c = aiConfig();
  const res = await fetchImpl(`${c.baseUrl}${path}`, { headers: headers(c), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: ((await res.json()) as { data: T }).data };
}

export const fetchCatalog = (fetchImpl: typeof fetch = fetch) => getJson<CatalogModel[]>('/models', fetchImpl);
export const fetchKey = (fetchImpl: typeof fetch = fetch) =>
  getJson<{ is_free_tier?: boolean; usage_daily?: number; limit?: number | null; limit_remaining?: number | null }>('/key', fetchImpl);

/** Free, text-only models in the catalog that support what `fn` needs (for `ai:doctor`). */
export const freeTextModels = (catalog: CatalogModel[], params: readonly string[] = ['response_format']) =>
  catalog.filter((m) => m.id.endsWith(':free') && modelProblems(m.id, m, params, true).length === 0).map((m) => m.id);

/** Runs the catalog + key check and stores it for `aiHealth()`. Never throws. */
export async function validateAi(fetchImpl: typeof fetch = fetch, fns: AiFn[] = ['grader', 'rubric', 'extract']): Promise<AiHealth> {
  const c = aiConfig();
  const log = createLogger({ requestId: 'ai-boot' });
  if (aiMode() !== 'live') {
    health = { ...aiHealth(), checkedAt: new Date().toISOString() };
    return health;
  }
  const problems: string[] = [];
  const need = new Map<string, Set<string>>();
  for (const fn of fns) for (const m of chainFor(fn)) for (const p of PARAMS_BY_FN[fn] ?? []) need.set(m, (need.get(m) ?? new Set()).add(p));
  let key: KeyInfo | null = null;
  try {
    const catalog = await fetchCatalog(fetchImpl);
    if (!catalog.ok) problems.push(`GET /models answered ${catalog.status}`);
    else {
      const byId = new Map(catalog.data.map((m) => [m.id, m]));
      for (const m of catalog.data) rememberPrice(m.id, num(m.pricing?.prompt) ?? 0, num(m.pricing?.completion) ?? 0);
      for (const [id, params] of need) {
        problems.push(...modelProblems(id, byId.get(id), [...params], c.requireFree));
        const why = refusal(id, c);
        if (why) problems.push(`${id}: ${why}`);
      }
    }
    const k = await fetchKey(fetchImpl);
    if (!k.ok) problems.push(k.status === 401 ? 'key is invalid (401)' : `GET /key answered ${k.status}`);
    else {
      key = { isFreeTier: k.data.is_free_tier ?? null, usageDaily: num(k.data.usage_daily), limit: num(k.data.limit), limitRemaining: num(k.data.limit_remaining) };
      if (key.limitRemaining !== null && key.limitRemaining <= 0) problems.push('key has no credit left (402 likely)');
    }
  } catch (e) {
    problems.push(`catalog check failed: ${e instanceof Error ? e.name : 'error'}`);
  }
  health = { status: problems.length ? 'degraded' : 'ok', model: c.model ?? null, fallbacks: c.fallbacks, problems, key, checkedAt: new Date().toISOString() };
  if (problems.length) log.warn('ai config problems', { problems });
  else log.info('ai config ok', { model: c.model, fallbacks: c.fallbacks });
  return health;
}
