import { getDocumentProxy } from 'unpdf';

export interface PdfLayoutBox { x: number; y: number; width: number; height: number }
export interface PdfLayoutItem extends PdfLayoutBox { text: string }
export interface PdfLayoutPage {
  /** One-based page number. Geometry uses the rotated scale=1 viewport, top-left origin. */
  page: number;
  width: number;
  height: number;
  items: PdfLayoutItem[];
  /** Absent means figure geometry was NOT verified, never “no figures”. */
  images?: PdfLayoutBox[];
  /** Private extraction evidence: text geometry was discarded, never inferred. */
  ocrRequiredReason?: "font_metrics_nonfinite";
}
export type PdfLayoutErrorCode = 'pdf_empty' | 'pdf_too_large' | 'pdf_too_many_pages' | 'pdf_too_many_items' | 'pdf_aborted' | 'pdf_unreadable' | 'pdf_invalid_geometry' | 'pdf_invalid_page';
export class PdfLayoutError extends Error {
  constructor(readonly code: PdfLayoutErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'PdfLayoutError';
  }
}
export const PDF_LAYOUT_LIMITS = { bytes: 100 * 1024 * 1024, pages: 1000, itemsPerPage: 100_000 } as const;
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PdfLayoutError('pdf_aborted');
}
/** One rotated scale=1 viewport, without extracting text from any page. Abort remains cooperative between pdf.js calls. */
export async function readPdfPageGeometry(bytes:Uint8Array,pageNumber:number,options:{signal?:AbortSignal}={}):Promise<{page:number;width:number;height:number;totalPages:number}>{
  checkAbort(options.signal);
  if(!Number.isInteger(pageNumber)||pageNumber<1||pageNumber>500)throw new PdfLayoutError('pdf_invalid_page');
  if(bytes.byteLength===0)throw new PdfLayoutError('pdf_empty');
  if(bytes.byteLength>PDF_LAYOUT_LIMITS.bytes)throw new PdfLayoutError('pdf_too_large');
  let doc:Awaited<ReturnType<typeof getDocumentProxy>>|undefined;
  try{
    doc=await getDocumentProxy(bytes.slice(),{verbosity:0});checkAbort(options.signal);
    if(doc.numPages>500)throw new PdfLayoutError('pdf_too_many_pages');
    if(pageNumber>doc.numPages)throw new PdfLayoutError('pdf_invalid_page');
    const page=await doc.getPage(pageNumber);
    try{
      checkAbort(options.signal);const viewport=page.getViewport({scale:1});
      if(![viewport.width,viewport.height,...viewport.transform].every(Number.isFinite)||viewport.width<=0||viewport.height<=0)throw new PdfLayoutError('pdf_invalid_geometry');
      return{page:pageNumber,width:viewport.width,height:viewport.height,totalPages:doc.numPages};
    }finally{page.cleanup();}
  }catch(error){if(error instanceof PdfLayoutError)throw error;throw new PdfLayoutError('pdf_unreadable',{cause:error});}
  finally{if(doc)await doc.loadingTask.destroy();}
}
/** Real PDF geometry, without AI or regex fallbacks. Zero text may mean OCR is needed.
 * Figure geometry is unknown. Abort is cooperative between bounded pdf.js calls. */
export async function readPdfLayout(bytes: Uint8Array, options: { signal?: AbortSignal; allowFontMetricOcr?: boolean } = {}): Promise<{ pages: PdfLayoutPage[] }> {
  checkAbort(options.signal);
  if (bytes.byteLength === 0) throw new PdfLayoutError('pdf_empty');
  if (bytes.byteLength > PDF_LAYOUT_LIMITS.bytes) throw new PdfLayoutError('pdf_too_large');
  let doc: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    doc = await getDocumentProxy(bytes.slice(), { verbosity: 0 });
    checkAbort(options.signal);
    if (doc.numPages > PDF_LAYOUT_LIMITS.pages) throw new PdfLayoutError('pdf_too_many_pages');
    const pages: PdfLayoutPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      checkAbort(options.signal);
      const page = await doc.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        if (![viewport.width, viewport.height, ...viewport.transform].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) throw new PdfLayoutError('pdf_invalid_geometry');
        const content = await page.getTextContent();
        checkAbort(options.signal);
        if (content.items.length > PDF_LAYOUT_LIMITS.itemsPerPage) throw new PdfLayoutError('pdf_too_many_items');
        const items: PdfLayoutItem[] = [];
        let requiresFontOcr = false;
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const [a, b, c, d, e, f] = item.transform as number[];
          if (![a, b, c, d, e, f, item.width, item.height].every(v => typeof v === 'number' && Number.isFinite(v)) || item.width < 0 || item.height < 0) throw new PdfLayoutError('pdf_invalid_geometry');
          const advanceLength = Math.hypot(a!, b!); const upLength = Math.hypot(c!, d!);
          if (![advanceLength, upLength].every(Number.isFinite) || advanceLength === 0 || upLength === 0) throw new PdfLayoutError('pdf_invalid_geometry');
          if (!item.str.trim()) continue;
          // Apply viewport rotation to all four glyph-box corners, not just its baseline.
          const advanceX = a! / advanceLength * item.width; const advanceY = b! / advanceLength * item.width;
          const style = content.styles[item.fontName];
          const ascent = style?.ascent ?? (style?.descent === undefined ? 1 : 1 + style.descent);
          if (![...viewport.convertToViewportPoint(e!, f!)].every(Number.isFinite)) throw new PdfLayoutError('pdf_invalid_geometry');
          const metrics = [style?.ascent, style?.descent].filter(v => v !== undefined);
          if (metrics.some(v => !Number.isFinite(v)) || !Number.isFinite(ascent)) {
            // Opt-in accepts only NaN font metrics, never Infinity or invalid item transforms.
            if (!options.allowFontMetricOcr || metrics.some(v => !Number.isFinite(v) && !Number.isNaN(v))) throw new PdfLayoutError('pdf_invalid_geometry');
            requiresFontOcr = true;
            continue; // Continue validating every later raw item; never break after a bad font.
          }
          const upX = c! / upLength * item.height; const upY = d! / upLength * item.height;
          const bottomX = e! + upX * (ascent - 1); const bottomY = f! + upY * (ascent - 1);
          const points = [viewport.convertToViewportPoint(bottomX, bottomY), viewport.convertToViewportPoint(bottomX + advanceX, bottomY + advanceY), viewport.convertToViewportPoint(bottomX + upX, bottomY + upY), viewport.convertToViewportPoint(bottomX + advanceX + upX, bottomY + advanceY + upY)];
          const xs = points.map(p => p[0]!); const ys = points.map(p => p[1]!);
          if (![...xs, ...ys].every(Number.isFinite)) throw new PdfLayoutError('pdf_invalid_geometry');
          const x = Math.min(...xs); const y = Math.min(...ys);
          items.push({ text: item.str, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
        }
        pages.push({ page: pageNumber, width: viewport.width, height: viewport.height, items: requiresFontOcr ? [] : items, ...(requiresFontOcr ? { ocrRequiredReason: "font_metrics_nonfinite" as const } : {}) });
      } finally { page.cleanup(); }
    }
    return { pages };
  } catch (error) {
    if (error instanceof PdfLayoutError) throw error;
    throw new PdfLayoutError('pdf_unreadable', { cause: error });
  } finally { if (doc) await doc.loadingTask.destroy(); }
}
