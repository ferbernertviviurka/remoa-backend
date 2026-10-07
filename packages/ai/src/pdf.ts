import { cleanText } from './text';

/** Page objects in the file. `/Pages` (the tree) is not a page. At least 1 so a file without a catalog still counts. */
export function pdfPageCount(bytes: Uint8Array): number {
  const raw = new TextDecoder('latin1').decode(bytes);
  const pages = raw.match(/\/Type\s*\/Page(?!s)/g);
  return Math.max(1, pages?.length ?? 0);
}

/** Pulls visible text out of a PDF byte string. Enough for text-based PDFs; scanned pages stay empty. */
export function pdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder('latin1').decode(bytes);
  const parts: string[] = [];
  for (const match of raw.matchAll(/\((?:\\\)|\\.|\([^)]*|[^)])*\)/g)) {
    const inner = match[0].slice(1, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
    if (/[A-Za-zÀ-ÿ]{4}/.test(inner)) parts.push(inner);
  }
  return cleanText(parts.join('\n')).replace(/[ \t]+/g, ' ').trim();
}

/**
 * Text of a real PDF (compressed streams, CID fonts with ToUnicode) via pdf.js (`unpdf`). D-581: the byte regex above alone
 * reads only uncompressed literal strings, so almost every exported PDF came out empty and failed as `pdf_unreadable`.
 * Falls back to `pdfText` only when pdf.js cannot open the file. Scanned pages still need OCR.
 * D-1568: pdf.js text always wins once it opens the file; on a compressed book the byte regex reads stream bytes as 1M+
 * characters of noise, and "longer wins" sent that noise to the model (308-page PDF failed as `invalid_output`).
 */
export async function readPdfText(bytes: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(bytes.slice(), { verbosity: 0 }); // copy: pdf.js may take the buffer
    const { text } = await extractText(doc, { mergePages: true });
    // D-1568: a word hyphenated at the line end is joined ("man-\nagement"), so a card quoting it passes the literal source check.
    return cleanText(text).replace(/[ \t]+/g, ' ').replace(/(\p{Ll})- ?\n ?(\p{Ll})/gu, '$1$2').trim();
  } catch {
    return pdfText(bytes);
  }
}
