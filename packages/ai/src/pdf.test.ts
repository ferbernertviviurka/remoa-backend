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
});
