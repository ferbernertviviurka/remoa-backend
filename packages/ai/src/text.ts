/**
 * D-1446: Postgres refuses NUL (`\u0000`) in `text` ("invalid byte sequence for encoding UTF8: 0x00") and lone surrogates in
 * `jsonb`. PDF extraction and model output can carry both. Strips C0 controls except tab, line feed and carriage return, and
 * unpaired surrogates. Every text that reaches the database or the model goes through here.
 */
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const cleanText = (s: string): string => s.replace(UNSAFE, '');

/** `cleanText` on every string inside arrays and plain objects (cards, edges, job input). Dates and other instances pass as they are. */
export function cleanDeep<T>(value: T): T {
  if (typeof value === 'string') return cleanText(value) as T;
  if (Array.isArray(value)) return value.map(cleanDeep) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v)])) as T;
  }
  return value;
}
