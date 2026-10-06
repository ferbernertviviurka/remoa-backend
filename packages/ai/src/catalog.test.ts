import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiHealth, freeTextModels, modelProblems, validateAi, type CatalogModel } from './catalog';
import { costCents } from './client';

const ENV = { ...process.env };
const KEY = 'sk-or-v1-CATALOGSECRET';
beforeEach(() => {
  process.env.OPENROUTER_API_KEY = KEY;
  process.env.AI_MODEL = 'v/main:free';
  process.env.AI_MODEL_FALLBACKS = 'v/backup:free';
  process.env.AI_REQUIRE_FREE = '1';
});
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

const ALL = ['response_format', 'tools', 'tool_choice', 'max_tokens', 'temperature'];
const model = (id: string, o: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ALL,
  ...o,
});
const api = (models: CatalogModel[], key: Response | Record<string, unknown> = { is_free_tier: true, usage_daily: 0, limit: null, limit_remaining: null }) => {
  const seen: { url: string; auth: string }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: (init?.headers as Record<string, string>).authorization ?? "" });
    if (url.endsWith('/models')) return Response.json({ data: models });
    return key instanceof Response ? key : Response.json({ data: key });
  }) as typeof fetch;
  return { impl, seen };
};

describe('modelProblems', () => {
  it('flags a missing, paid, multimodal or under-featured model', () => {
    expect(modelProblems('x', undefined, [], true)).toEqual(['x: not in the catalog']);
    expect(modelProblems('x', model('x', { pricing: { prompt: '0.000001', completion: '0' } }), [], true)).toEqual(['x: price is not zero']);
    expect(modelProblems('x', model('x', { pricing: { prompt: '0.000001', completion: '0' } }), [], false)).toEqual([]);
    expect(modelProblems('x', model('x', { architecture: { input_modalities: ['text', 'image'] } }), [], true)[0]).toMatch(/not text only/);
    expect(modelProblems('x', model('x', { supported_parameters: ['max_tokens'] }), ['tools', 'tool_choice'], true)[0]).toMatch(/does not support tools, tool_choice/);
    expect(modelProblems('x', model('x'), ['tools'], true)).toEqual([]);
  });
  it('suggests only free, text-only models with the needed parameters', () => {
    const list = [model('a:free'), model('b'), model('c:free', { architecture: { input_modalities: ['text', 'image'] } }), model('d:free', { supported_parameters: [] })];
    expect(freeTextModels(list)).toEqual(['a:free']);
  });
});

describe('validateAi', () => {
  it('ok: model and fallbacks exist, free, text only, parameters supported; key read; prices remembered', async () => {
    const f = api([model('v/main:free'), model('v/backup:free'), model('v/paid', { pricing: { prompt: '0.000002', completion: '0.000004' } })]);
    const h = await validateAi(f.impl);
    expect(h).toMatchObject({ status: 'ok', model: 'v/main:free', fallbacks: ['v/backup:free'], problems: [], key: { isFreeTier: true, usageDaily: 0 } });
    expect(f.seen.map((s) => s.url)).toEqual(['http://ai.test/api/v1/models', 'http://ai.test/api/v1/key']);
    expect(costCents(1_000_000, 0, 'v/paid')).toBe(200);
    expect(aiHealth()).toEqual(h);
    expect(JSON.stringify(h)).not.toContain(KEY);
  });
  it('degraded: missing fallback, multimodal main, unsupported tools, invalid key; never throws', async () => {
    const f = api([model('v/main:free', { architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['response_format'] })], new Response('{}', { status: 401 }));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const h = await validateAi(f.impl);
    expect(h.status).toBe('degraded');
    expect(h.problems).toEqual(expect.arrayContaining([
      'v/main:free: accepts text+image, not text only',
      'v/main:free: does not support tools, tool_choice',
      'v/backup:free: not in the catalog',
      'key is invalid (401)',
    ]));
  });
  it('degraded: a paid model with AI_REQUIRE_FREE, a catalog error and no credit left', async () => {
    process.env.AI_MODEL = 'v/paid';
    delete process.env.AI_MODEL_FALLBACKS;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const h = await validateAi(api([model('v/paid', { pricing: { prompt: '0.1', completion: '0' } })], { limit: 1, limit_remaining: 0 }).impl);
    expect(h.problems).toEqual(expect.arrayContaining(['v/paid: price is not zero', expect.stringMatching(/AI_REQUIRE_FREE/), 'key has no credit left (402 likely)']));
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect((await validateAi(down)).problems).toEqual(['GET /models answered 503', 'GET /key answered 503']);
    const boom = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect((await validateAi(boom)).problems).toEqual(['catalog check failed: TypeError']);
  });
  it('off and mock: no request, health says why (names of variables only)', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const f = api([]);
    expect(await validateAi(f.impl)).toMatchObject({ status: 'off', problems: ['missing OPENROUTER_API_KEY'] });
    process.env.AI = 'mock';
    expect(aiHealth()).toMatchObject({ status: 'mock', problems: [] });
    expect(f.seen).toHaveLength(0);
  });
});
