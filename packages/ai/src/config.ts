// G22 (D-1404): the one place that reads the AI settings. Provider, address, models, fallbacks and limits come only from `.env`:
// free models leave the OpenRouter catalog without notice, so no model id is written in code.
import { z } from 'zod';

export type AiFn = 'grader' | 'rubric' | 'extract' | (string & {});

export type AiConfig = {
  provider: 'openrouter';
  /** AI_BASE_URL without a trailing slash, e.g. the OpenRouter API root. Required for live calls. */
  baseUrl: string | undefined;
  /** OPENROUTER_API_KEY. Never logged, never returned by health or doctor. */
  apiKey: string | undefined;
  model: string | undefined;
  fallbacks: string[];
  requireFree: boolean;
  allowFreeInProd: boolean;
  dataCollection: 'allow' | 'deny';
  timeoutMs: number;
  maxRetries: number;
  rpmLimit: number;
  rpdLimit: number;
  appUrl: string | undefined;
  appName: string | undefined;
  /** NODE_ENV unset counts as production (same fail-closed rule as the API boot). */
  production: boolean;
};

const flag = z.enum(['0', '1', 'true', 'false', '']).optional().transform((v) => v === '1' || v === 'true');
const int = (def: number, min: number) => z.coerce.number().int().min(min).optional().transform((v) => v ?? def);
const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

const schema = z.object({
  AI_PROVIDER: z.enum(['openrouter']).optional().default('openrouter'),
  AI_BASE_URL: z.string().url().optional(),
  AI_DATA_COLLECTION: z.enum(['allow', 'deny']).optional().default('deny'),
  AI_REQUIRE_FREE: flag,
  AI_ALLOW_FREE_IN_PROD: flag,
  AI_TIMEOUT_MS: int(45_000, 1_000),
  AI_MAX_RETRIES: int(2, 0),
  AI_RPM_LIMIT: int(15, 1),
  AI_RPD_LIMIT: int(40, 1),
});

/** Read on every call (cheap), so tests and scripts can change process.env. Throws on a malformed value, never on a missing one. */
export function aiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const clean = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, blank(v)]));
  const p = schema.parse(clean);
  return {
    provider: p.AI_PROVIDER,
    baseUrl: p.AI_BASE_URL?.replace(/\/+$/, ''),
    apiKey: blank(env.OPENROUTER_API_KEY),
    model: blank(env.AI_MODEL),
    fallbacks: (env.AI_MODEL_FALLBACKS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    requireFree: p.AI_REQUIRE_FREE,
    allowFreeInProd: p.AI_ALLOW_FREE_IN_PROD,
    dataCollection: p.AI_DATA_COLLECTION,
    timeoutMs: p.AI_TIMEOUT_MS,
    maxRetries: p.AI_MAX_RETRIES,
    rpmLimit: p.AI_RPM_LIMIT,
    rpdLimit: p.AI_RPD_LIMIT,
    appUrl: blank(env.AI_APP_URL),
    appName: blank(env.AI_APP_NAME),
    production: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
  };
}

/** AI_MODEL_<FN> (e.g. AI_MODEL_GRADER, AI_MODEL_EXTRACT) when set, else AI_MODEL. */
export const modelFor = (fn: AiFn, env: NodeJS.ProcessEnv = process.env): string | undefined =>
  blank(env[`AI_MODEL_${fn.toUpperCase()}`]) ?? aiConfig(env).model;

/** The models a call to `fn` may use, in order, without repeats. */
export const chainFor = (fn: AiFn, env: NodeJS.ProcessEnv = process.env): string[] => {
  const first = modelFor(fn, env);
  return [...new Set([...(first ? [first] : []), ...aiConfig(env).fallbacks])];
};

/** What is missing for live calls (names of env vars only). Empty = configured. */
export function missingConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const c = aiConfig(env);
  return [!c.apiKey && 'OPENROUTER_API_KEY', !c.baseUrl && 'AI_BASE_URL', !c.model && 'AI_MODEL'].filter((x): x is string => Boolean(x));
}

/**
 * D-580: `mock` (AI=mock, dev/test only: the API refuses to boot with it otherwise) = deterministic offline output, no provider call.
 * `live` = OpenRouter (key, base URL and model all set). `off` = generation answers 503 `ai_unavailable`; grader/rubric use the local rubric.
 */
export type AiMode = 'live' | 'mock' | 'off';
export const aiMode = (env: NodeJS.ProcessEnv = process.env): AiMode => (env.AI === 'mock' ? 'mock' : missingConfig(env).length ? 'off' : 'live');
