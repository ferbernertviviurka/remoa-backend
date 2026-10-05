import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pdfText, readPdfText } from './pdf';

/** A one-page PDF whose content stream is FlateDecode, like Word/Google Docs/Chrome exports. */
function compressedPdf(lines: string[]): Uint8Array {
  const content = deflateSync(Buffer.from(`BT /F1 12 Tf 50 700 Td ${lines.map((l) => `(${l}) Tj 0 -20 Td`).join(' ')} ET`, 'latin1'));
  const objs = [
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>'),
    Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>'),
    Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>'),
    Buffer.concat([Buffer.from(`<</Length ${content.length}/Filter/FlateDecode>>stream\n`), content, Buffer.from('\nendstream')]),
    Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  objs.forEach((o, i) => {
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    offsets.push(size);
    parts.push(obj);
    size += obj.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xref}trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${size}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

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
