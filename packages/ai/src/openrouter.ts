import { graderVerdictSchema, type GraderInput, type GraderVerdict } from '@remoa/contracts';

export const GRADER_PROMPT_VERSION = 'grader/v2';
export const RUBRIC_PROMPT_VERSION = 'rubric/v1';
export const EXTRACT_PROMPT_VERSION = 'extract/v1';

export const graderModel = () => process.env.OPENROUTER_GRADER_MODEL ?? 'anthropic/claude-3.5-haiku';
export const rubricModel = () => process.env.OPENROUTER_RUBRIC_MODEL ?? 'anthropic/claude-3.5-sonnet';
export const extractModel = () => process.env.OPENROUTER_EXTRACT_MODEL ?? 'anthropic/claude-3.5-sonnet';

/**
 * D-580: who writes generated maps. `mock` (AI=mock, dev/test only: the API refuses to boot with it otherwise) = deterministic
 * offline extraction, no OpenRouter/Mistral call. `live` = OpenRouter (+ Mistral OCR when MISTRAL_API_KEY is set). `off` = no key and
 * no mock: generation answers 503 `ai_unavailable` instead of passing a paragraph split off as an AI map.
 */
export type AiMode = 'live' | 'mock' | 'off';
export const aiMode = (): AiMode => (process.env.AI === 'mock' ? 'mock' : process.env.OPENROUTER_API_KEY ? 'live' : 'off');

export type Completion = { text: string; model: string; tokensIn: number; tokensOut: number };

type Chat = { model: string; system: string; user: string; timeoutMs?: number; fetchImpl?: typeof fetch; tool?: 'grade' };

const gradeTool = {
  type: 'function',
  function: {
    name: 'grade',
    description: 'Veredito da resposta somente contra a rubrica.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'] },
        matched: { type: 'array', items: { type: 'string' } },
        missing: { type: 'array', items: { type: 'string' } },
        criticalError: { type: 'boolean' },
        feedback: { type: 'string' },
      },
      required: ['verdict', 'matched', 'missing', 'criticalError', 'feedback'],
    },
  },
};

function requestBody(opts: Chat, stream: boolean) {
  const messages = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  const graded = opts.tool === 'grade';
  return {
    model: opts.model,
    messages,
    ...(stream ? { stream: true } : {}),
    ...(graded
      ? { tools: [gradeTool], tool_choice: { type: 'function', function: { name: 'grade' } } }
      : { response_format: { type: 'json_object' } }),
  };
}

type ModelMessage = { content?: string; tool_calls?: { function?: { arguments?: string } }[] };

/** OpenRouter chat completions. The grader uses a tool; other calls use JSON object mode. Throws when the key is missing or the call fails. */
export async function completeJSON(opts: Chat): Promise<Completion> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('missing_openrouter_key');
  const res = await (opts.fetchImpl ?? fetch)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(opts, false)),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
  });
  if (!res.ok) throw new Error(`openrouter_${res.status}`);
  const body = (await res.json()) as {
    model?: string;
    choices?: { message?: ModelMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = body.choices?.[0]?.message;
  const text = message?.tool_calls?.[0]?.function?.arguments || message?.content || '';
  return {
    text,
    model: body.model ?? opts.model,
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
  };
}

/** The feedback string so far, including a value the model has not closed yet. */
export function feedbackSoFar(json: string): string {
  const key = '"feedback"';
  const at = json.indexOf(key);
  if (at < 0) return '';
  const colon = json.indexOf(':', at + key.length);
  if (colon < 0) return '';
  const quote = json.indexOf('"', colon + 1);
  if (quote < 0) return '';
  let out = '';
  for (let i = quote + 1; i < json.length; i++) {
    const ch = json[i];
    if (ch === undefined) break;
    if (ch === '\\') {
      const next = json[i + 1];
      if (next === undefined) break;
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i += 1;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
  }
  return out;
}

type StreamPart = { delta: string; model: string; tokensIn: number; tokensOut: number };

/** Token stream from OpenRouter. Throws when the key is missing or the call fails. */
export async function* streamJSON(opts: Chat): AsyncGenerator<StreamPart> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('missing_openrouter_key');
  const res = await (opts.fetchImpl ?? fetch)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(opts, true)),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
  });
  if (!res.ok || !res.body) throw new Error(`openrouter_${res.status}`);
  const reader = res.body.getReader();
  const decode = new TextDecoder();
  let buf = '';
  let model = opts.model;
  let tokensIn = 0;
  let tokensOut = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decode.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      const json = JSON.parse(data) as {
        model?: string;
        choices?: { delta?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
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
}

export function parseVerdict(text: string, model: string): GraderVerdict {
  const raw = JSON.parse(text) as Record<string, unknown>;
  delete raw.costCents;
  return graderVerdictSchema.parse({ ...raw, model: raw.model ?? model });
}

export function graderUser(input: GraderInput): string {
  return JSON.stringify({
    prompt: input.prompt,
    rubric: input.rubric,
    neighbors: input.neighbors,
    answer: input.answer,
  });
}
