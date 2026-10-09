import { captureHttpEnvelope, HTTP_RECEIPT_MAX_BODY_BYTES, type HttpCompletionEnvelope } from './http-envelope';
// G22 (D-1404–D-1409): the only HTTP client to an AI provider. OpenAI-compatible `POST {AI_BASE_URL}/chat/completions` (OpenRouter).
// Retry with exponential backoff + jitter only on 429/5xx/timeout; fallback through AI_MODEL_FALLBACKS; classified errors;
// a local per-minute/per-day counter; free/prod guards; one log line per attempt with no prompt, reply or key.
import { nextCompletionReceipt, hasCompletionReceiptScope, ReceiptPersistenceError } from './receipts';
import type { ZodType, ZodTypeDef } from 'zod';
import { createLogger } from '@remoa/log';
import { aiConfig, chainFor, missingConfig, type AiConfig, type AiFn } from './config';

// ---------------------------------------------------------------------------------------------------------------------------
// Errors

export type AiErrorCode =
  | 'not_configured'
  | 'model_refused'
  | 'invalid_key'
  | 'insufficient_credits'
  | 'model_not_found'
  | 'data_policy'
  | 'timeout'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'provider_error'
  | 'invalid_output'
  | 'empty_output';

/** pt-BR text safe to show a user or an operator. The backend does not import @remoa/strings, so it lives here (same as e-mail copy). */
export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  not_configured: 'A IA não está configurada neste ambiente.',
  model_refused: 'O modelo de IA configurado não é permitido neste ambiente.',
  invalid_key: 'A chave da IA é inválida. Avise o suporte.',
  insufficient_credits: 'A conta de IA está sem saldo. Avise o suporte.',
  model_not_found: 'O modelo de IA configurado não está disponível.',
  data_policy: 'Nenhum provedor de IA aceita a política de dados configurada.',
  timeout: 'A IA demorou demais para responder. Tente de novo.',
  rate_limited: 'Muitas chamadas à IA agora. Tente de novo em instantes.',
  quota_exceeded: 'O limite diário de IA foi atingido. Tente de novo amanhã.',
  provider_error: 'O provedor de IA falhou. Tente de novo em instantes.',
  invalid_output: 'A IA devolveu uma resposta fora do formato. Tente de novo.',
  empty_output: 'A IA não devolveu resposta. Tente de novo.',
};

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number | undefined;
  /** True when the local counter blocked the call (no request left the process). */
  readonly local: boolean;
  /** A failure never spends the user's plan quota; only a successful completion does. */
  readonly billable = false;
  /** Caller cancellation, or a request the provider will refuse again (400/403). */
  readonly final: boolean;
  /** Tokens a call spent before failing (invalid output after repair), so callers can still record the cost. */
  readonly usage: { model: string; tokensIn: number; tokensOut: number; latencyMs: number } | undefined;
  constructor(code: AiErrorCode, opts: { status?: number; local?: boolean; final?: boolean; detail?: string; usage?: AiError['usage'] } = {}) {
    super(opts.detail ? `${code}: ${opts.detail}` : code);
    this.name = 'AiError';
    this.code = code;
    this.status = opts.status;
    this.local = opts.local ?? false;
    this.final = opts.final ?? false;
    this.usage = opts.usage;
  }
  get userMessage() {
    return AI_ERROR_MESSAGES[this.code];
  }
  /** Same model again after a pause. Never on 401/402/404. */
  get retryable() {
    return !this.local && !this.final && (this.code === 'rate_limited' || this.code === 'provider_error' || this.code === 'timeout');
  }
  /** Next model in AI_MODEL_FALLBACKS. Account-level failures (key, credits, data policy, local limits) are not the model's fault. */
  get fallbackable() {
    return !this.local && (this.code === 'model_not_found' || this.retryable);
  }
}

/** Status + provider message → code. OpenRouter says "No endpoints found matching your data policy" for the privacy 404. */
export function classify(status: number, message = ''): AiError {
  const m = message.toLowerCase();
  const detail = message.slice(0, 200);
  if (status === 401) return new AiError('invalid_key', { status, detail });
  if (status === 402) return new AiError('insufficient_credits', { status, detail });
  if (status === 404 && /data policy|privacy|data_collection/.test(m)) return new AiError('data_policy', { status, detail });
  if (status === 404) return new AiError('model_not_found', { status, detail });
  if (status === 400 && /model/.test(m) && /(not a valid|not found|does not exist|unknown)/.test(m)) return new AiError('model_not_found', { status, detail });
  if (status === 408 || status === 504) return new AiError('timeout', { status, detail });
  if (status === 429) return new AiError('rate_limited', { status, detail });
  if (status >= 500) return new AiError('provider_error', { status, detail });
  // 400/403 (bad request, moderation): the same request will fail again, so no retry and no fallback.
  return new AiError('provider_error', { status, final: status < 500, detail });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Local counter (requests per minute and per UTC day, the OpenRouter day)

/**
 * ponytail: in-process memory, valid while the API runs as one Railway replica (Q-160). With more than one replica the
 * counter moves to Postgres (one row per UTC day, `update ... returning`), since the OpenRouter limit is per account.
 */
const usage = { minute: [] as number[], day: '', count: 0, warnedMinute: 0, warnedDay: '' };

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export function aiUsage(now = Date.now()) {
  const c = aiConfig();
  const minute = usage.minute.filter((t) => now - t < 60_000).length;
  const day = usage.day === utcDay(now) ? usage.count : 0;
  return { minute, day, rpmLimit: c.rpmLimit, rpdLimit: c.rpdLimit, utcDay: utcDay(now) };
}

/** Scripts load and save their own day count (a file) so separate runs share the 40-call budget. */
export function seedUsage(day: string, count: number) {
  usage.day = day;
  usage.count = count;
}

export function resetUsage() {
  usage.minute = [];
  usage.day = '';
  usage.count = 0;
  usage.warnedMinute = 0;
  usage.warnedDay = '';
}

/** Takes one slot or throws `rate_limited` (minute) / `quota_exceeded` (day) without calling the API. Warns once at 80%. */
function takeSlot(c: AiConfig, log: ReturnType<typeof createLogger>, now = Date.now()) {
  usage.minute = usage.minute.filter((t) => now - t < 60_000);
  const today = utcDay(now);
  if (usage.day !== today) {
    usage.day = today;
    usage.count = 0;
  }
  if (usage.count >= c.rpdLimit) throw new AiError('quota_exceeded', { local: true, detail: `AI_RPD_LIMIT ${c.rpdLimit}` });
  if (usage.minute.length >= c.rpmLimit) throw new AiError('rate_limited', { local: true, detail: `AI_RPM_LIMIT ${c.rpmLimit}` });
  usage.minute.push(now);
  usage.count += 1;
  if (usage.count >= Math.ceil(c.rpdLimit * 0.8) && usage.warnedDay !== today) {
    usage.warnedDay = today;
    log.warn('ai daily limit at 80%', { used: usage.count, limit: c.rpdLimit, utcDay: today });
  }
  if (usage.minute.length >= Math.ceil(c.rpmLimit * 0.8) && now - usage.warnedMinute >= 60_000) {
    usage.warnedMinute = now;
    log.warn('ai minute limit at 80%', { used: usage.minute.length, limit: c.rpmLimit });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Guards

/** Catalog prices from the boot check (`validateAi`); used by the AI_REQUIRE_FREE guard once known. */
const knownPrices = new Map<string, { prompt: number; completion: number }>();
export const rememberPrice = (id: string, prompt: number, completion: number) => knownPrices.set(id, { prompt, completion });

/**
 * Integer cents from the catalog price (USD per token) read at boot: 0 for a :free model or one the catalog has not given yet.
 * A paid call under half a cent is recorded as 1, because `ai_calls.cost_cents` is an integer. No price table in code (D-1410).
 */
export function costCents(tokensIn: number, tokensOut: number, model = ''): number {
  const price = knownPrices.get(model);
  if (!price || (tokensIn <= 0 && tokensOut <= 0)) return 0;
  const cents = (tokensIn * price.prompt + tokensOut * price.completion) * 100;
  return cents > 0 ? Math.max(1, Math.round(cents)) : 0;
}

/** Blocked whatever the env says: Opus drained the OpenRouter credit, and the auto router may pick it. */
const BLOCKED = /opus|^openrouter\/auto/i;

/** Why a model may not be used here, or null. */
export function refusal(model: string, c: AiConfig = aiConfig()): string | null {
  if(!/^[a-zA-Z0-9/_.:@+-]{1,200}$/.test(model))return 'model identifier invalid';
  if (BLOCKED.test(model)) return 'model blocked in packages/ai (Opus or the auto router)';
  const price = knownPrices.get(model);
  if (c.requireFree && !model.endsWith(':free')) return 'AI_REQUIRE_FREE=1 and the model id does not end in :free';
  if (c.requireFree && price && (price.prompt !== 0 || price.completion !== 0)) return 'AI_REQUIRE_FREE=1 and the catalog price is not zero';
  // G22 qa (P-615, D-1435): "free" for the production lock also means the free router (`…/free`) and any model the catalog
  // prices at zero, not only the `:free` suffix. Without the catalog only the id is known (fails open on price, closed on the id).
  const free = model.endsWith(':free') || model.endsWith('/free') || (price !== undefined && price.prompt === 0 && price.completion === 0);
  if (c.production && free && !c.allowFreeInProd) return 'free model in production without AI_ALLOW_FREE_IN_PROD=1';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Requests

export type Tool = { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } };

export type ChatOptions = {
  /** Tag for logs and per-function model (AI_MODEL_<FN>). */
  fn: AiFn;
  system: string;
  user: string;
  /** JSON object mode (`response_format`). Ignored when `tool` is set. */
  json?: boolean;
  /** Forces one function call; its arguments are the reply text. */
  tool?: Tool;
  maxTokens?: number;
  temperature?: number;
  /**
   * false = ask the model not to think before answering (OpenRouter `reasoning.enabled`; ignored by models without reasoning).
   * The free Nemotron spent ~1 000 reasoning tokens (~8 s) per grade and blew the 8 s budget (G22 live round, D-1442).
   */
  reasoning?: false;
  /** Per attempt; default AI_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Caller cancellation: no retry, no fallback. */
  signal?: AbortSignal;
  requestId?: string;
  fetchImpl?: typeof fetch;
  /** Tests: no real waits. */
  sleep?: (ms: number) => Promise<void>;
};

/** `latencyMs` covers every attempt (retries, fallbacks) until the reply was read; callers record it in `ai_calls`. */
export type Completion = { text: string; model: string; tokensIn: number; tokensOut: number; latencyMs: number; attempts: number; fallback: boolean; billable: true };

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

/** Parameters the app sends; the boot check requires each model to support the ones its functions use. */
export const USED_PARAMETERS = ['response_format', 'tools', 'tool_choice'] as const;

function body(model: string, messages: Message[], o: ChatOptions, c: AiConfig, stream: boolean) {
  return {
    model,
    messages,
    ...(stream ? { stream: true } : {}),
    ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
    ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    ...(o.reasoning === false ? { reasoning: { enabled: false } } : {}),
    ...(o.tool
      ? { tools: [o.tool], tool_choice: { type: 'function', function: { name: o.tool.function.name } } }
      : o.json
        ? { response_format: { type: 'json_object' } }
        : {}),
    provider: { data_collection: c.dataCollection, ...(c.zdr ? { zdr: true } : {}) },
  };
}

export function headers(c: AiConfig): Record<string, string> {
  return {
    authorization: `Bearer ${c.apiKey ?? ''}`,
    'content-type': 'application/json',
    ...(c.appUrl ? { 'HTTP-Referer': c.appUrl } : {}),
    ...(c.appName ? { 'X-Title': c.appName } : {}),
  };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 500 ms, 1 s, 2 s ... capped at 8 s, ±50% jitter. */
export const backoffMs = (attempt: number, rand = Math.random) => Math.round(Math.min(8_000, 500 * 2 ** attempt) * (0.5 + rand()));

type Usage = { prompt_tokens?: number; completion_tokens?: number };
type ApiError = { error?: { code?: number | string; message?: string } };

async function errorOf(res: Response): Promise<AiError> {
  let message = '';
  try {
    const j = (await res.json()) as ApiError;
    message = j.error?.message ?? '';
  } catch {
    /* no JSON body */
  }
  return classify(res.status, message);
}

const logOf = (o: Pick<ChatOptions, 'fn' | 'requestId'>) => createLogger({ requestId: o.requestId ?? 'ai' });

/** One line per attempt. Only metadata: never the prompt, the reply or the key. */
function logAttempt(o: Pick<ChatOptions, 'fn' | 'requestId'>, f: { model: string; attempt: number; fallback: boolean; latencyMs: number; status: number | string; code?: AiErrorCode; tokensIn?: number; tokensOut?: number; repaired?: boolean }) {
  const line = { fn: o.fn, ...f };
  if (f.code) logOf(o).warn('ai call', line);
  else logOf(o).info('ai call', line);
}

export type Raw = { res: Response; model: string; attempts: number; fallback: boolean; started: number; firstStarted: number };

/**
 * Retry + fallback loop shared by chat and OCR. `request` does one HTTP call for `model`; `count` = it spends the OpenRouter
 * account limits (AI_RPM_LIMIT/AI_RPD_LIMIT). Returns the first OK response with its body unread.
 */
export async function withRetries(
  o: Pick<ChatOptions, 'fn' | 'signal' | 'timeoutMs' | 'requestId' | 'sleep'>,
  models: string[],
  request: (model: string, signal: AbortSignal) => Promise<Response>,
  opts: { count: boolean; needBody?: boolean; primary?: string },
): Promise<Raw> {
  const c = aiConfig();
  const log = logOf(o);
  const sleep = o.sleep ?? defaultSleep;
  let last: AiError = new AiError('provider_error');
  let attempts = 0;
  const firstStarted = Date.now();
  for (const [i, model] of models.entries()) {
    const fallback = i > 0 || (opts.primary !== undefined && model !== opts.primary);
    if (i > 0) log.warn('ai fallback', { fn: o.fn, from: models[i - 1], to: model, code: last.code });
    for (let attempt = 0; attempt <= c.maxRetries; attempt++) {
      if (o.signal?.aborted) throw new AiError('timeout', { final: true, detail: 'aborted' });
      if (opts.count) takeSlot(c, log);
      attempts += 1;
      const started = Date.now();
      const timeout = AbortSignal.timeout(o.timeoutMs ?? c.timeoutMs);
      try {
        const res = await request(model, o.signal ? AbortSignal.any([timeout, o.signal]) : timeout);
        if (res.ok && (!opts.needBody || res.body)) return { res, model, attempts, fallback, started, firstStarted };
        last = res.ok ? new AiError('empty_output', { status: res.status }) : await errorOf(res);
      } catch (e) {
        if (o.signal?.aborted) {
          logAttempt(o, { model, attempt, fallback, latencyMs: Date.now() - started, status: 'aborted', code: 'timeout' });
          throw new AiError('timeout', { final: true, detail: 'aborted' });
        }
        last = e instanceof AiError ? e : timeout.aborted ? new AiError('timeout', { detail: 'AI_TIMEOUT_MS' }) : new AiError('provider_error', { detail: e instanceof Error ? e.name : 'fetch failed' });
      }
      logAttempt(o, { model, attempt, fallback, latencyMs: Date.now() - started, status: last.status ?? 'network', code: last.code });
      // A receipt reservation covers exactly one uncertain provider request.
      // Do not retry or fall back when its completion may already exist remotely.
      if (hasCompletionReceiptScope(o.fn) && !last.local && (last.code==='timeout' || last.status===undefined || last.status<400)) throw last;
      if (!last.retryable) break;
      if (attempt < c.maxRetries) await sleep(backoffMs(attempt));
    }
    if (!last.fallbackable) throw last;
  }
  throw last;
}

/** Sends one chat request with retries and fallbacks; returns the first OK response (body unread). */
async function send(o: ChatOptions, messages: Message[], stream: boolean): Promise<Raw> {
  const c = aiConfig();
  const missing = missingConfig();
  if (missing.length) throw new AiError('not_configured', { local: true, detail: missing.join(',') });
  const chain = chainFor(o.fn);
  const allowed = chain.filter((m) => {
    const why = refusal(m, c);
    if (why) logOf(o).warn('ai model refused', { fn: o.fn, model: m, reason: why });
    return !why;
  });
  if (!allowed.length) throw new AiError('model_refused', { local: true, detail: chain.join(',') });
  const doFetch = o.fetchImpl ?? fetch;
  const post = (model: string, signal: AbortSignal, opts: ChatOptions) =>
    doFetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers: headers(c), body: JSON.stringify(body(model, messages, opts, c, stream)), signal });
  const withReasoning = { ...o, reasoning: undefined };
  return withRetries(
    o,
    allowed,
    async (model, signal) => {
      if (o.reasoning !== false) return post(model, signal, o);
      if (reasoningMandatory.has(model)) return post(model, signal, withReasoning);
      const res = await post(model, signal, o);
      if (res.status !== 400 || !/reasoning is mandatory/i.test(await res.clone().text())) return res;
      reasoningMandatory.add(model);
      return post(model, signal, withReasoning);
    },
    { count: true, needBody: stream, primary: chain[0] },
  );
}

/**
 * G22 (production model): some paid models refuse `reasoning.enabled=false` with a 400 "Reasoning is mandatory" (Gemini 3.5
 * Flash Lite, GPT-5 nano). The same attempt is sent again without the field, and the model is remembered for this process.
 */
const reasoningMandatory = new Set<string>();

type ChatBody = ApiError & { model?: string; choices?: { message?: { content?: string | null; tool_calls?: { function?: { arguments?: string } }[] } }[]; usage?: Usage };

export function completionFromEnvelope(envelope:HttpCompletionEnvelope):Completion {
  if(envelope.version!==1 || typeof envelope.bodyComplete!=='boolean' || typeof envelope.bodyBase64!=='string' || envelope.bodyBase64.length>Math.ceil(HTTP_RECEIPT_MAX_BODY_BYTES/3)*4 || !Number.isSafeInteger(envelope.bodyBytes)||envelope.bodyBytes<0||envelope.bodyBytes>HTTP_RECEIPT_MAX_BODY_BYTES || typeof envelope.model!=='string'|| !/^[a-zA-Z0-9/_.:@+-]{1,200}$/.test(envelope.model) || !Number.isSafeInteger(envelope.status)||envelope.status<200||envelope.status>299 || !Number.isSafeInteger(envelope.attempts)||envelope.attempts<1 || typeof envelope.fallback!=='boolean' || !Number.isFinite(envelope.latencyMs)||envelope.latencyMs<0 || ![null,'body_limit','body_read_failed'].includes(envelope.errorCode) || ![null,'application/json','text/plain'].includes(envelope.contentType) || envelope.bodyComplete&&envelope.errorCode!==null)throw new AiError('invalid_output',{status:200,final:true,detail:'envelope_metadata_invalid'});
  if(!envelope.bodyComplete)throw new AiError('invalid_output',{status:200,final:true,detail:envelope.errorCode??'incomplete_body'});
  let json:ChatBody;
  try { const bytes=Buffer.from(envelope.bodyBase64,'base64');if(bytes.length!==envelope.bodyBytes || bytes.toString('base64')!==envelope.bodyBase64)throw Error('invalid_bytes');json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as ChatBody; }catch{throw new AiError('invalid_output',{status:200,final:true,detail:'body is not valid UTF-8 JSON'});}
  if(!json || typeof json!=='object' || Array.isArray(json))throw new AiError('invalid_output',{status:200,final:true});
  if(json.error){const error=classify(Number(json.error.code)||502,json.error.message);throw new AiError(error.code,{status:200,final:true,detail:'provider_error_envelope'});}
  const message=json.choices?.[0]?.message;
  const text=message?.tool_calls?.[0]?.function?.arguments || message?.content || '';
  if(typeof text!=='string')throw new AiError('invalid_output',{status:200,final:true});
  if(json.model!==undefined && (typeof json.model!=='string'||! /^[a-zA-Z0-9/_.:@+-]{1,200}$/.test(json.model)) || [json.usage?.prompt_tokens,json.usage?.completion_tokens].some(value=>value!==undefined && (!Number.isSafeInteger(value)||Number(value)<0)))throw new AiError('invalid_output',{status:200,final:true});
  if(!text.trim())throw new AiError('empty_output',{status:200,final:true});
  return{text,model:typeof json.model==='string'?json.model:envelope.model,tokensIn:json.usage?.prompt_tokens??0,tokensOut:json.usage?.completion_tokens??0,latencyMs:envelope.latencyMs,attempts:envelope.attempts,fallback:envelope.fallback,billable:true};
}

async function complete(o: ChatOptions, messages: Message[], repaired?: boolean, checkpoint?:(envelope:HttpCompletionEnvelope)=>Promise<void>): Promise<Completion> {
  const raw = await send(o, messages, false);
  const envelope=await captureHttpEnvelope(raw.res,{model:raw.model,attempts:raw.attempts,fallback:raw.fallback,latencyMs:Date.now()-raw.firstStarted});
  if(checkpoint)await checkpoint(envelope);
  const done=completionFromEnvelope(envelope);
  logAttempt(o, { model: done.model, attempt: raw.attempts - 1, fallback: raw.fallback, latencyMs: Date.now() - raw.started, status: 200, tokensIn: done.tokensIn, tokensOut: done.tokensOut, ...(repaired ? { repaired } : {}), ...(done.text.trim() ? {} : { code: 'empty_output' as const }) });

  return done;
}

const first = (o: ChatOptions): Message[] => [
  { role: 'system', content: o.system },
  { role: 'user', content: o.user },
];

/** Plain completion (with `json`/`tool` when asked). Throws AiError. */
export const generateText = (o: ChatOptions): Promise<Completion> => complete(o, first(o));

/** Valid-JSON rate before and after the one repair call, over replies that arrived (G22 Phase 2 reads it). In memory, per process. */
export const jsonStats = { calls: 0, validFirst: 0, validAfterRepair: 0, invalid: 0 };

/**
 * The JSON object in a reply. Free models often wrap it in a ```json fence or a sentence (G22 live round, D-1438): the
 * outermost {...} is taken. Still only JSON reaches the schema; nothing is "fixed" inside it.
 */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw e;
    return JSON.parse(text.slice(start, end + 1));
  }
}

function check<T>(schema: ZodType<T, ZodTypeDef, unknown>, text: string): { ok: true; data: T } | { ok: false; issue: string } {
  let raw: unknown;
  try {
    raw = parseJsonText(text);
  } catch (e) {
    return { ok: false, issue: `JSON inválido: ${e instanceof Error ? e.message : 'erro de leitura'}` };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, issue: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ') };
}

/**
 * JSON validated by `schema`. If the first reply is invalid, ONE repair call sends the reply back with the validation error.
 * Still invalid → AiError `invalid_output`. Tokens of both calls are summed.
 */
export async function generateJson<T>(schema: ZodType<T, ZodTypeDef, unknown>, o: ChatOptions): Promise<Completion & { data: T; repaired: boolean }> {
  const opts = o.tool ? o : { ...o, json: true };
  const completeDurably = async (messages: Message[], repaired = false) => {
    const receipt = nextCompletionReceipt(opts.fn,repaired);
    try {
      const replay = receipt ? await receipt.hooks.load(receipt.call) : null;
      if(replay)return replay;
      const completion = await complete(opts,messages,repaired,receipt?.hooks.saveEnvelope ? envelope=>receipt.hooks.saveEnvelope!(receipt.call,envelope) : undefined);
      if(receipt)await receipt.hooks.save(receipt.call,completion);
      return completion;
    } catch(error) {
      if(error instanceof AiError){if(receipt?.hooks.failed)try{await receipt.hooks.failed(receipt.call,{code:error.code,knownNoCompletion:error.local || error.code!=='timeout' && error.status!==undefined && error.status>=400});}catch{throw new ReceiptPersistenceError('receipt_failure_record_failed');}throw error;}
      if(error instanceof ReceiptPersistenceError)throw error;
      throw new ReceiptPersistenceError(error instanceof Error ? error.name : 'unknown');
    }
  };
  const done = await completeDurably(first(opts));
  // Counted only once the model replied: a transport error (429, 400, timeout) is not an invalid JSON (G22 live round, D-1438).
  jsonStats.calls += 1;
  const firstTry = check(schema, done.text);
  if (firstTry.ok) {
    jsonStats.validFirst += 1;
    return { ...done, data: firstTry.data, repaired: false };
  }
  const fix = await completeDurably([
    ...first(opts),
    { role: 'assistant', content: done.text },
    { role: 'user', content: `Sua resposta não passou na validação: ${firstTry.issue}. Responda de novo só com o JSON corrigido, no mesmo formato pedido, sem texto fora dele.` },
  ], true);
  const second = check(schema, fix.text);
  const merged = { ...fix, tokensIn: done.tokensIn + fix.tokensIn, tokensOut: done.tokensOut + fix.tokensOut, latencyMs: done.latencyMs + fix.latencyMs, attempts: done.attempts + fix.attempts };
  if (!second.ok) {
    jsonStats.invalid += 1;
    logOf(opts).warn('ai json invalid after repair', { fn: opts.fn, model: fix.model });
    throw new AiError('invalid_output', { detail: second.issue.slice(0, 200), usage: { model: merged.model, tokensIn: merged.tokensIn, tokensOut: merged.tokensOut, latencyMs: merged.latencyMs } });
  }
  jsonStats.validAfterRepair += 1;
  return { ...merged, data: second.data, repaired: true };
}

export type StreamPart = { delta: string; model: string; tokensIn: number; tokensOut: number };

/** SSE token stream. Retries and fallbacks apply until the response starts; a failure mid-stream throws AiError. */
export async function* streamText(o: ChatOptions): AsyncGenerator<StreamPart> {
  const raw = await send(o, first(o), true);
  const reader = raw.res.body!.getReader();
  const decode = new TextDecoder();
  let buf = '';
  let model = raw.model;
  let tokensIn = 0;
  let tokensOut = 0;
  let status: number | string = 200;
  let code: AiErrorCode | undefined;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new AiError('timeout', { final: Boolean(o.signal?.aborted), detail: 'stream interrupted' });
      }
      if (chunk.done) break;
      buf += decode.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" keep-alives
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        let json: ApiError & { model?: string; choices?: { delta?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[]; usage?: Usage };
        try {
          json = JSON.parse(data);
        } catch {
          throw new AiError('invalid_output', { detail: 'bad SSE line' });
        }
        if (json.error) throw classify(Number(json.error.code) || 502, json.error.message);
        if (json.model) model = json.model;
        if (json.usage) {
          tokensIn = json.usage.prompt_tokens ?? tokensIn;
          tokensOut = json.usage.completion_tokens ?? tokensOut;
        }
        const piece = json.choices?.[0]?.delta;
        const delta = piece?.tool_calls?.[0]?.function?.arguments ?? piece?.content ?? '';
        if (delta) yield { delta, model, tokensIn, tokensOut };
      }
    }
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError('provider_error');
    status = err.status ?? 'stream';
    code = err.code;
    throw err;
  } finally {
    await reader.cancel().catch(() => undefined);
    logAttempt(o, { model, attempt: raw.attempts - 1, fallback: raw.fallback, latencyMs: Date.now() - raw.started, status, tokensIn, tokensOut, ...(code ? { code } : {}) });
  }
}
