import { describe, expect, it } from 'vitest';
import { pdfText, readPdfText } from './pdf';
import { syntheticPdf as compressedPdf } from '../eval/model/synthetic-pdf';

describe('readPdfText (D-581)', () => {
  const lines = ['Insuficiencia cardiaca com fracao de ejecao reduzida', 'Diureticos aliviam a congestao'];

  it('reads a compressed PDF that the byte regex cannot', async () => {
    const bytes = compressedPdf(lines);
    expect(pdfText(bytes)).not.toContain('ejecao');
    const text = await readPdfText(bytes);
    expect(text).toContain('fracao de ejecao reduzida');
    expect(text).toContain('Diureticos');
  });

  it('falls back to the literal strings when pdf.js cannot open the file', async () => {
    expect(await readPdfText(new TextEncoder().encode('%PDF-1.4 (Sepse e choque septico exige noradrenalina) Tj'))).toContain('noradrenalina');
  });

  it('D-1446: NUL and C0 controls inside the text never leave (Postgres refuses 0x00)', async () => {
    const text = await readPdfText(new TextEncoder().encode('%PDF-1.4 (Sep\u0000se e cho\u0001que septico exige noradrenalina) Tj'));
    expect(text).toContain('Sepse e choque septico');
    expect(text).not.toMatch(/[\u0000-\u0008]/);
  });
});
