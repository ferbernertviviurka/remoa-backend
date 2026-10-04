import { afterEach, describe, expect, it } from 'vitest';
import { ocrPdf } from './ocr';

const scanned = new TextEncoder().encode('no parenthetical text here');

describe('ocr', () => {
  const prev = process.env.MISTRAL_API_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = prev;
  });

  it('does not call Mistral without a key', async () => {
    delete process.env.MISTRAL_API_KEY;
    const text = await ocrPdf(scanned, () => {
      throw new Error('should not fetch');
    });
    expect(text).toBe('');
  });

  it('uses the markdown pages when the key is set', async () => {
    process.env.MISTRAL_API_KEY = 'test-key';
    const text = await ocrPdf(scanned, async () => Response.json({ pages: [{ markdown: 'Noradrenalina em choque séptico refratário a volume.' }] }));
    expect(text).toContain('Noradrenalina');
  });

  it('keeps the literal text when Mistral fails', async () => {
    process.env.MISTRAL_API_KEY = 'test-key';
    const bytes = new TextEncoder().encode('(Sepse grave no pronto atendimento)');
    const text = await ocrPdf(bytes, async () => {
      throw new Error('down');
    });
    expect(text).toContain('Sepse');
  });
});
