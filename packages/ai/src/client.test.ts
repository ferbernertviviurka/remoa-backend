import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiError, aiUsage, backoffMs, classify, generateJson, generateText, jsonStats, refusal, rememberPrice, resetUsage, seedUsage, streamText, withRetries, type ChatOptions } from './client';
import { aiConfig, aiMode, chainFor, missingConfig, modelFor } from './config';

const ENV = { ...process.env };
const SECRET_KEY = 'sk-or-v1-SUPERSECRETKEY';
beforeEach(() => {
  resetUsage();
  process.env.OPENROUTER_API_KEY = SECRET_KEY;
  process.env.AI_MAX_RETRIES = '2';
});
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
/** A fetch that answers from a script (one entry per call) and records each request. */
function scripted(...replies: (Response | Error | (() => Response | Promise<Response>))[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')), headers: init?.headers as Record<string, string> });
    const next = replies.shift() ?? new Response('{}', { status: 599 });
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { impl, calls };
}
const ok = (content: string, extra: Record<string, unknown> = {}) => Response.json({ model: 'test/model', choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 4 }, ...extra });
const fail = (status: number, message = 'x') => Response.json({ error: { code: status, message } }, { status });
const noSleep = vi.fn(async () => undefined);
const opts = (o: Partial<ChatOptions> = {}): ChatOptions => ({ fn: 'test', system: 'sys', user: 'user', sleep: noSleep, ...o });

describe('config', () => {
  it('reads every AI_* setting from env with safe defaults', () => {
    const c = aiConfig({ AI_BASE_URL: 'https://x.test/api/v1/', AI_MODEL_FALLBACKS: ' a:free , b:free,', NODE_ENV: 'test' });
    expect(c).toMatchObject({ provider: 'openrouter', baseUrl: 'https://x.test/api/v1', fallbacks: ['a:free', 'b:free'], dataCollection: 'deny', timeoutMs: 45_000, maxRetries: 2, rpmLimit: 15, rpdLimit: 40, requireFree: false, allowFreeInProd: false, production: false });
    expect(aiConfig({}).production).toBe(true);
    expect(aiConfig({ AI_REQUIRE_FREE: '1', AI_ALLOW_FREE_IN_PROD: 'true', AI_DATA_COLLECTION: 'allow' })).toMatchObject({ requireFree: true, allowFreeInProd: true, dataCollection: 'allow' });
    expect(() => aiConfig({ AI_PROVIDER: 'anthropic' })).toThrow();
  });
  it('per-function model falls back to AI_MODEL; chain dedupes', () => {
    const env = { AI_MODEL: 'm1', AI_MODEL_GRADER: 'g1', AI_MODEL_FALLBACKS: 'm1,f1' };
    expect(modelFor('grader', env)).toBe('g1');
    expect(modelFor('extract', env)).toBe('m1');
    expect(chainFor('grader', env)).toEqual(['g1', 'm1', 'f1']);
    expect(chainFor('extract', env)).toEqual(['m1', 'f1']);
    expect(chainFor('extract', {})).toEqual([]);
  });
  it('mode: mock wins, live needs key + base URL + model, otherwise off', () => {
    expect(aiMode({ AI: 'mock' })).toBe('mock');
    expect(aiMode({ OPENROUTER_API_KEY: 'k', AI_BASE_URL: 'https://x.test', AI_MODEL: 'm' })).toBe('live');
    expect(aiMode({ OPENROUTER_API_KEY: 'k' })).toBe('off');
    expect(missingConfig({})).toEqual(['OPENROUTER_API_KEY', 'AI_BASE_URL', 'AI_MODEL']);
  });
});

describe('classify', () => {
  it.each([
    [401, '', 'invalid_key'],
    [402, '', 'insufficient_credits'],
    [404, 'No endpoints found matching your data policy', 'data_policy'],
    [404, 'No endpoints found for x', 'model_not_found'],
    [400, 'x is not a valid model ID', 'model_not_found'],
    [408, '', 'timeout'],
    [504, '', 'timeout'],
    [429, '', 'rate_limited'],
    [500, '', 'provider_error'],
    [503, '', 'provider_error'],
    [400, 'bad', 'provider_error'],
  ] as const)('%i %s -> %s', (status, message, code) => {
    const e = classify(status, message);
    expect(e.code).toBe(code);
    expect(e.billable).toBe(false);
    expect(e.userMessage.length).toBeGreaterThan(10);
  });
  it('retries only 429, 5xx and timeout', () => {
    expect([401, 402, 404, 400, 403].map((s) => classify(s).retryable)).toEqual([false, false, false, false, false]);
    expect([429, 500, 502, 503, 408, 504].map((s) => classify(s).retryable)).toEqual([true, true, true, true, true, true]);
    expect(classify(404).fallbackable).toBe(true);
    expect(classify(404, 'data policy').fallbackable).toBe(false);
    expect(classify(402).fallbackable).toBe(false);
  });
  it('backoff grows exponentially with jitter, capped at 8 s', () => {
    expect(backoffMs(0, () => 0.5)).toBe(500);
    expect(backoffMs(1, () => 0.5)).toBe(1000);
    expect(backoffMs(2, () => 0)).toBe(1000);
    expect(backoffMs(10, () => 0.5)).toBe(8000);
  });
});

describe('generateText: request', () => {
  it('posts to {AI_BASE_URL}/chat/completions with headers, data_collection and the configured model', async () => {
    process.env.AI_APP_URL = 'https://app.example.test';
    process.env.AI_APP_NAME = 'Remoa';
    process.env.AI_DATA_COLLECTION = 'allow';
    const f = scripted(ok('oi'));
    const done = await generateText(opts({ fetchImpl: f.impl, maxTokens: 50, temperature: 0 }));
    expect(done).toMatchObject({ text: 'oi', model: 'test/model', tokensIn: 3, tokensOut: 4, attempts: 1, fallback: false, billable: true });
    expect(done.latencyMs).toBeGreaterThanOrEqual(0);
    expect(f.calls[0]!.url).toBe('http://ai.test/api/v1/chat/completions');
    expect(f.calls[0]!.headers).toMatchObject({ authorization: `Bearer ${SECRET_KEY}`, 'HTTP-Referer': 'https://app.example.test', 'X-Title': 'Remoa' });
    expect(f.calls[0]!.body).toMatchObject({ model: 'test/model', max_tokens: 50, temperature: 0, provider: { data_collection: 'allow' } });
    expect(f.calls[0]!.body.response_format).toBeUndefined();
  });
  it('sends a forced tool and reads its arguments', async () => {
    const f = scripted(Response.json({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"a":1}' } }] } }] }));
    const tool = { type: 'function' as const, function: { name: 'grade', parameters: {} } };
    const done = await generateText(opts({ fetchImpl: f.impl, tool }));
    expect(done.text).toBe('{"a":1}');
    expect(f.calls[0]!.body).toMatchObject({ tools: [tool], tool_choice: { type: 'function', function: { name: 'grade' } } });
  });
  it('without configuration: not_configured, no request', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const f = scripted();
    await expect(generateText(opts({ fetchImpl: f.impl }))).rejects.toMatchObject({ code: 'not_configured', local: true });
    expect(f.calls).toHaveLength(0);
  });
  it('empty reply and 200-with-error body are classified', async () => {
    await expect(generateText(opts({ fetchImpl: scripted(ok('  ')).impl }))).rejects.toMatchObject({ code: 'empty_output' });
    await expect(generateText(opts({ fetchImpl: scripted(Response.json({ error: { code: 402, message: 'neg' } })).impl }))).rejects.toMatchObject({ code: 'insufficient_credits' });
    await expect(generateText(opts({ fetchImpl: scripted(new Response('not json')).impl }))).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

describe('retry and fallback', () => {
  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    noSleep.mockClear();
    const f = scripted(fail(429), fail(503), ok('ok'));
    const done = await generateText(opts({ fetchImpl: f.impl }));
    expect(done.attempts).toBe(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });
  it.each([401, 402, 404])('never retries %i', async (status) => {
    const f = scripted(fail(status), ok('never'));
    await expect(generateText(opts({ fetchImpl: f.impl }))).rejects.toBeInstanceOf(AiError);
    expect(f.calls).toHaveLength(1);
  });
  it('retries a timeout (AI_TIMEOUT_MS per attempt), then succeeds', async () => {
    let n = 0;
    const impl = (async (_u: string, init?: RequestInit) => {
      n += 1;
      if (n > 1) return ok('ok');
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    }) as typeof fetch;
    const done = await generateText(opts({ fetchImpl: impl, timeoutMs: 20 }));
    expect(done.attempts).toBe(2);
  });
  it('a timeout on every attempt is classified as timeout', async () => {
    process.env.AI_MAX_RETRIES = '1';
    const impl = (async (_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    await expect(generateText(opts({ fetchImpl: impl, timeoutMs: 20 }))).rejects.toMatchObject({ code: 'timeout' });
  });
  it('falls back to the next model on a removed model, persistent 429 and exhausted 5xx, and says so', async () => {
    process.env.AI_MODEL_FALLBACKS = 'fb/one,fb/two,fb/three';
    process.env.AI_MAX_RETRIES = '1';
    const f = scripted(fail(404, 'model gone'), fail(429), fail(429), fail(500), fail(502), ok('ok', { model: 'fb/three' }));
    const done = await generateText(opts({ fetchImpl: f.impl }));
    expect(f.calls.map((c) => c.body.model)).toEqual(['test/model', 'fb/one', 'fb/one', 'fb/two', 'fb/two', 'fb/three']);
    expect(done).toMatchObject({ model: 'fb/three', fallback: true, attempts: 6 });
  });
  it('does not fall back on account errors (401, 402, data policy)', async () => {
    process.env.AI_MODEL_FALLBACKS = 'fb/one';
    for (const r of [fail(401), fail(402), fail(404, 'No endpoints found matching your data policy')]) {
      const f = scripted(r, ok('never'));
      await expect(generateText(opts({ fetchImpl: f.impl }))).rejects.toBeInstanceOf(AiError);
      expect(f.calls).toHaveLength(1);
    }
  });
  it('throws the last error when every model fails; a network error is provider_error', async () => {
    process.env.AI_MAX_RETRIES = '0';
    process.env.AI_MODEL_FALLBACKS = 'fb/one';
    await expect(generateText(opts({ fetchImpl: scripted(new TypeError('fetch failed'), fail(500)).impl }))).rejects.toMatchObject({ code: 'provider_error', status: 500 });
  });
  it('caller cancellation stops at once: no retry, no fallback', async () => {
    process.env.AI_MODEL_FALLBACKS = 'fb/one';
    const ctrl = new AbortController();
    const f = scripted(() => {
      ctrl.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(generateText(opts({ fetchImpl: f.impl, signal: ctrl.signal }))).rejects.toMatchObject({ code: 'timeout', final: true });
    expect(f.calls).toHaveLength(1);
    await expect(generateText(opts({ fetchImpl: f.impl, signal: ctrl.signal }))).rejects.toMatchObject({ code: 'timeout' });
    expect(f.calls).toHaveLength(1);
  });
  it('withRetries without counting does not touch the OpenRouter counter', async () => {
    const raw = await withRetries({ fn: 'ocr', sleep: noSleep }, ['ocr-model'], async () => new Response('{}'), { count: false });
    expect(raw.model).toBe('ocr-model');
    expect(aiUsage().day).toBe(0);
  });
});

describe('local counter', () => {
  it('blocks at AI_RPM_LIMIT without calling the API, and warns at 80%', async () => {
    process.env.AI_RPM_LIMIT = '5';
    process.env.LOG_LEVEL = 'info';
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (writes.push(String(s)), true));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const f = scripted(...Array.from({ length: 6 }, () => ok('ok')));
    for (let i = 0; i < 5; i++) await generateText(opts({ fetchImpl: f.impl }));
    await expect(generateText(opts({ fetchImpl: f.impl }))).rejects.toMatchObject({ code: 'rate_limited', local: true });
    expect(f.calls).toHaveLength(5);
    expect(writes.filter((w) => w.includes('ai minute limit at 80%'))).toHaveLength(1);
    expect(aiUsage()).toMatchObject({ minute: 5, day: 5, rpmLimit: 5 });
  });
  it('blocks at AI_RPD_LIMIT for the UTC day (quota_exceeded, never retried), warns once at 80%, resets next day', async () => {
    process.env.AI_RPD_LIMIT = '5';
    process.env.LOG_LEVEL = 'info';
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (writes.push(String(s)), true));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    seedUsage(new Date().toISOString().slice(0, 10), 3);
    const f = scripted(ok('a'), ok('b'), ok('c'));
    await generateText(opts({ fetchImpl: f.impl }));
    await generateText(opts({ fetchImpl: f.impl }));
    await expect(generateText(opts({ fetchImpl: f.impl }))).rejects.toMatchObject({ code: 'quota_exceeded', local: true, retryable: false });
    expect(f.calls).toHaveLength(2);
    expect(writes.filter((w) => w.includes('ai daily limit at 80%'))).toHaveLength(1);
    seedUsage('2000-01-01', 99);
    await generateText(opts({ fetchImpl: f.impl }));
    expect(aiUsage().day).toBe(1);
  });
  it('a 429 retry spends a slot per attempt (the provider counts every request)', async () => {
    await generateText(opts({ fetchImpl: scripted(fail(429), ok('ok')).impl }));
    expect(aiUsage().day).toBe(2);
  });
});

describe('guards', () => {
  it('AI_REQUIRE_FREE refuses a paid id and a :free id with a non-zero catalog price', () => {
    const c = { ...aiConfig(), requireFree: true, production: false };
    expect(refusal('vendor/paid', c)).toMatch(/:free/);
    expect(refusal('vendor/ok:free', c)).toBeNull();
    rememberPrice('vendor/sneaky:free', 0.000001, 0);
    expect(refusal('vendor/sneaky:free', c)).toMatch(/price/);
  });
  it('production refuses a :free model unless AI_ALLOW_FREE_IN_PROD=1', () => {
    expect(refusal('vendor/x:free', { ...aiConfig(), production: true, allowFreeInProd: false })).toMatch(/production/);
    expect(refusal('vendor/x:free', { ...aiConfig(), production: true, allowFreeInProd: true })).toBeNull();
    expect(refusal('vendor/paid', { ...aiConfig(), production: true })).toBeNull();
  });
  it('skips refused models in the chain; none left = model_refused without a request', async () => {
    process.env.AI_REQUIRE_FREE = '1';
    process.env.AI_MODEL_FALLBACKS = 'vendor/ok:free';
    const f = scripted(ok('ok'));
    const done = await generateText(opts({ fetchImpl: f.impl }));
    expect(f.calls[0]!.body.model).toBe('vendor/ok:free');
    expect(done.fallback).toBe(true);
    delete process.env.AI_MODEL_FALLBACKS;
    await expect(generateText(opts({ fetchImpl: f.impl }))).rejects.toMatchObject({ code: 'model_refused' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('generateJson', () => {
  const schema = z.object({ n: z.number() });
  it('valid first time: no repair', async () => {
    const before = { ...jsonStats };
    const f = scripted(ok('{"n":1}'));
    const done = await generateJson(schema, opts({ fetchImpl: f.impl }));
    expect(done).toMatchObject({ data: { n: 1 }, repaired: false });
    expect(f.calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(jsonStats.validFirst - before.validFirst).toBe(1);
  });
  it('one repair call with the validation error, tokens summed', async () => {
    const before = { ...jsonStats };
    const f = scripted(ok('{"n":"um"}'), ok('{"n":1}'));
    const done = await generateJson(schema, opts({ fetchImpl: f.impl }));
    expect(done).toMatchObject({ data: { n: 1 }, repaired: true, tokensIn: 6, tokensOut: 8 });
    const msgs = f.calls[1]!.body.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[3]!.content).toContain('n:');
    expect(jsonStats.validAfterRepair - before.validAfterRepair).toBe(1);
  });
  it('still invalid after the one repair: invalid_output with the spent usage; never a third call', async () => {
    const f = scripted(ok('não é json'), ok('{"n":"x"}'), ok('{"n":1}'));
    const e = await generateJson(schema, opts({ fetchImpl: f.impl })).catch((x: AiError) => x);
    expect(e).toMatchObject({ code: 'invalid_output', usage: { tokensIn: 6, tokensOut: 8 } });
    expect(f.calls).toHaveLength(2);
    expect(String((f.calls[1]!.body.messages as { content: string }[])[3]!.content)).toContain('JSON inválido');
  });
});

describe('streamText', () => {
  const sse = (...lines: string[]) => new Response(lines.join(''));
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  it('yields deltas (content and tool arguments), skips keep-alives, keeps usage', async () => {
    const f = scripted(sse(': OPENROUTER PROCESSING\n\n', chunk({ choices: [{ delta: { content: 'a' } }] }), chunk({ model: 'm2', choices: [{ delta: { tool_calls: [{ function: { arguments: 'b' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), 'data: [DONE]\n\n'));
    const parts = [];
    for await (const p of streamText(opts({ fetchImpl: f.impl }))) parts.push(p);
    expect(parts.map((p) => p.delta).join('')).toBe('ab');
    expect(parts.at(-1)).toMatchObject({ model: 'm2', tokensIn: 1, tokensOut: 2 });
    expect(f.calls[0]!.body.stream).toBe(true);
  });
  it('retries before the stream starts', async () => {
    const f = scripted(fail(503), sse(chunk({ choices: [{ delta: { content: 'x' } }] })));
    const parts = [];
    for await (const p of streamText(opts({ fetchImpl: f.impl }))) parts.push(p);
    expect(parts).toHaveLength(1);
  });
  it('a mid-stream error event is classified; a broken line is invalid_output', async () => {
    const run = async (r: Response) => {
      for await (const _ of streamText(opts({ fetchImpl: scripted(r).impl }))) void _;
    };
    await expect(run(sse(chunk({ choices: [{ delta: { content: 'x' } }] }), chunk({ error: { code: 429, message: 'upstream' } })))).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(run(sse('data: {nope\n\n'))).rejects.toMatchObject({ code: 'invalid_output' });
  });
  it('a body that errors mid-read is a timeout; any other throw is provider_error', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('reset'));
      },
    });
    const run = async (r: Response) => {
      for await (const _ of streamText(opts({ fetchImpl: scripted(r).impl }))) void _;
    };
    await expect(run(new Response(broken))).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('log has no content', () => {
  it('one metadata line per call; never the prompt, the reply or the key', async () => {
    process.env.LOG_LEVEL = 'info';
    const lines: string[] = [];
    const grab = (s: string | Uint8Array) => (lines.push(String(s)), true);
    vi.spyOn(process.stdout, 'write').mockImplementation(grab);
    vi.spyOn(process.stderr, 'write').mockImplementation(grab);
    const promptSecret = 'PACIENTE-JOAO-CPF-123';
    const replySecret = 'RESPOSTA-SECRETA-XYZ';
    await generateText(opts({ fn: 'grader', user: promptSecret, system: promptSecret, fetchImpl: scripted(fail(500, `echo ${promptSecret}`), ok(replySecret)).impl, requestId: 'r1' }));
    const all = lines.join('');
    expect(all).not.toContain(promptSecret.slice(0, 12));
    expect(all).not.toContain(replySecret);
    expect(all).not.toContain(SECRET_KEY);
    const last = JSON.parse(lines.at(-1)!);
    expect(last).toMatchObject({ msg: 'ai call', requestId: 'r1', fn: 'grader', model: 'test/model', status: 200, tokensIn: 3, tokensOut: 4, attempt: 1, fallback: false });
    expect(typeof last.latencyMs).toBe('number');
    const failed = JSON.parse(lines[0]!);
    expect(failed).toMatchObject({ level: 'warn', code: 'provider_error', status: 500, attempt: 0 });
  });
});
