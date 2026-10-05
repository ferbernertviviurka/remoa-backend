import { readPdfText } from './pdf';

type OcrPage = { markdown?: string };
type OcrBody = { pages?: OcrPage[] };

/** Mistral OCR when MISTRAL_API_KEY is set. Otherwise the literal strings already in the file. */
export async function ocrPdf(bytes: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<string> {
  const literal = await readPdfText(bytes);
  const key = process.env.MISTRAL_API_KEY;
  if (!key || process.env.AI === 'mock') return literal; // D-580: the mock never calls a provider
  try {
    const document = Buffer.from(bytes).toString('base64');
    const res = await fetchImpl('https://api.mistral.ai/v1/ocr', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10 * 60 * 1000),
      body: JSON.stringify({
        model: 'mistral-ocr-latest',
        document: { type: 'document_url', document_url: `data:application/pdf;base64,${document}` },
      }),
    });
    if (!res.ok) return literal;
    const body = (await res.json()) as OcrBody;
    const text = (body.pages ?? []).map((page) => page.markdown ?? '').join('\n').trim();
    return text.length >= 40 ? text : literal;
  } catch {
    return literal;
  }
}
