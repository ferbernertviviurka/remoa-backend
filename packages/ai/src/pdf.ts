/** Pulls visible text out of a PDF byte string. Enough for text-based PDFs; scanned pages stay empty. */
export function pdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder('latin1').decode(bytes);
  const parts: string[] = [];
  for (const match of raw.matchAll(/\((?:\\\)|\\.|\([^)]*|[^)])*\)/g)) {
    const inner = match[0].slice(1, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
    if (/[A-Za-zÀ-ÿ]{4}/.test(inner)) parts.push(inner);
  }
  return parts.join('\n').replace(/[ \t]+/g, ' ').trim();
}
