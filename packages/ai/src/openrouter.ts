import { graderVerdictSchema, type GraderInput, type GraderVerdict } from '@remoa/contracts';

export const GRADER_PROMPT_VERSION = 'grader/v2';
export const RUBRIC_PROMPT_VERSION = 'rubric/v1';
export const EXTRACT_PROMPT_VERSION = 'extract/v1';

// G22 (D-1404): models, provider and transport moved to config.ts / client.ts; no model id is written in code.
export { aiMode, type AiMode } from './config';

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
