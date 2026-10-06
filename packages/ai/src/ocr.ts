import { withRetries } from './client';
import { readPdfText } from './pdf';

type OcrPage = { markdown?: string };
type OcrBody = { pages?: OcrPage[] };

/** A scanned PDF may take minutes; per attempt. */
const OCR_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Mistral OCR when MISTRAL_API_KEY and AI_OCR_MODEL are set (G22: no model id in code). Otherwise the literal strings already in
 * the file. Same retry, classification and content-free log as chat (`withRetries`); it does not spend the OpenRouter counter.
 */
export async function ocrPdf(bytes: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<string> {
  const literal = await readPdfText(bytes);
  const key = process.env.MISTRAL_API_KEY?.trim();
  const model = process.env.AI_OCR_MODEL?.trim();
  if (!key || !model || process.env.AI === 'mock') return literal; // D-580: the mock never calls a provider
  try {
    const document = Buffer.from(bytes).toString('base64');
    const raw = await withRetries(
      { fn: 'ocr', timeoutMs: OCR_TIMEOUT_MS },
      [model],
      (m, signal) =>
        fetchImpl('https://api.mistral.ai/v1/ocr', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          signal,
          body: JSON.stringify({ model: m, document: { type: 'document_url', document_url: `data:application/pdf;base64,${document}` } }),
        }),
      { count: false },
    );
    const body = (await raw.res.json()) as OcrBody;
    const text = (body.pages ?? []).map((page) => page.markdown ?? '').join('\n').trim();
    return text.length >= 40 ? text : literal;
  } catch {
    return literal;
  }
}
