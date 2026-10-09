import { createHash } from 'node:crypto';
import { pageLines, type PdfLine } from './layout';
import type { PdfLayoutPage, Provenance, SharedContextEvidence } from './types';

const declaration = /^\s*(?:TEXTO|CASO|ENUNCIADO|INFORMAÇÕES)\s+(?:COMUM\s+)?(?:PARA|DAS?)\s+(?:AS?\s+)?QUEST[ÕO]ES\b/i;
const isDeclaration = (text: string) => declaration.test(text.normalize('NFC'));
/** Strict context boundary: numbered prose/list items never terminate shared evidence. */
function boundary(line: PdfLine, following: PdfLine[]): boolean {
  const explicit = /^\s*(?:QUEST[ÃA]O|QUESTION)\s+\d{1,3}\b/i.test(line.text);
  if (!explicit && !/^\s*\d{1,3}\s*[{}]*\s*$/.test(line.text)) return false;
  const x = line.bbox.x / line.page.width;
  if (!explicit && !(x < 0.15 || (x >= 0.45 && x <= 0.6))) return false;
  const keys = new Set<string>();
  for (const next of following.filter(next => (next.bbox.x < line.page.width * 0.5) === (line.bbox.x < line.page.width * 0.5))) {
    if (isDeclaration(next.text) || /^\s*(?:QUEST[ÃA]O|QUESTION)\s+\d{1,3}\b/i.test(next.text) || /^\s*\d{1,3}\s*[{}]*\s*$/i.test(next.text)) break;
    const option = /^\s*(?:\(([A-Ja-j])\)|([A-Ja-j])[.)])\s*\S/.exec(next.text);
    if (option) keys.add((option[1] ?? option[2]!).toUpperCase());
  }
  return keys.size >= 2;
}
function declaredNumbers(text: string): number[] {
  const tail = text.normalize('NFC').replace(declaration, '').trim().replace(/[.:]\s*$/, '');
  const range = /^(\d{1,3})\s*(?:A|ATÉ|[-–—])\s*(\d{1,3})$/i.exec(tail);
  if (range) {
    const a = Number(range[1]), b = Number(range[2]);
    if (a >= 1 && b >= a && b <= 999 && b - a <= 49)
      return Array.from({ length: b - a + 1 }, (_, n) => a + n);
    return [];
  }
  if (!/^\d{1,3}(?:\s*(?:,|E)\s*\d{1,3})*$/i.test(tail)) return [];
  const result = tail.match(/\d{1,3}/g)?.map(Number) ?? [];
  return result.every(n => n >= 1 && n <= 999) ? [...new Set(result)] : [];
}
/** Extract before column partitioning; retain raw layout independently of detected candidates.
 * No context is medically accepted or bound by this extraction. Undefined continuation remains unresolved.
 */
export function extractSharedContexts(pages: PdfLayoutPage[]): {
  pages: PdfLayoutPage[];
  contexts: SharedContextEvidence[];
} {
  const contexts: SharedContextEvidence[] = [];
  const output: PdfLayoutPage[] = [];
  let pending: SharedContextEvidence | undefined;
  const append = (context: SharedContextEvidence, page: PdfLayoutPage, lines: PdfLine[], top: number, bottom: number) => {
    const items = lines.flatMap(line => line.items);
    context.originalText += (context.originalText && lines.length ? '\n' : '') + lines.map(line => line.text).join('\n');
    context.rawLayout.push(...items.map(item => ({...item})));
    context.rawPages.push({page:page.page,width:page.width,height:page.height,items:page.items.map(item=>({...item})),images:page.images?.map(image=>({...image}))});
    const region: Provenance = {page:page.page,bbox:{x:0,y:top,width:page.width,height:Math.max(1,bottom-top)},method:page.method??'text'};
    context.provenance.push(region);
    for (const image of page.images??[]) if(image.y+image.height>top && image.y<bottom) context.imageRefs.push({page:page.page,bbox:{...image},method:page.method??'text'});
    if(page.images===undefined && !context.issues.includes('figure_geometry_unknown'))context.issues.push('figure_geometry_unknown');
    if(/figura|tabela|imagem|gr[áa]fico/i.test(lines.map(line=>line.text).join(' ')) && !context.imageRefs.some(ref=>ref.page===page.page))context.imageRefs.push(region);
    return items;
  };
  for (const page of pages) {
    const lines = pageLines(page);
    const removed = new Set<PdfLayoutPage['items'][number]>();
    let start=0;
    if(pending){
      let end=0;
      while(end<lines.length && !isDeclaration(lines[end]!.text) && !boundary(lines[end]!,lines.slice(end+1)))end++;
      for(const item of append(pending,page,lines.slice(0,end),0,lines[end]?.bbox.y??page.height))removed.add(item);
      if(end<lines.length)pending=undefined;
      start=end;
    }
    for (; start < lines.length; start++) {
      const header=lines[start]!;
      if(!isDeclaration(header.text))continue;
      let end=start+1;
      while(end<lines.length && !isDeclaration(lines[end]!.text) && !boundary(lines[end]!,lines.slice(end+1)))end++;
      const declared=declaredNumbers(header.text);
      const context: SharedContextEvidence={evidenceHash:'',originalText:'',rawLayout:[],rawPageLayout:page.items.map(item=>({...item})),rawPages:[],declaredNumbers:declared,provenance:[],imageRefs:[],issues:declared.length?[]:['context_targets_unknown'],status:'unresolved'};
      for(const item of append(context,page,lines.slice(start,end),header.bbox.y,lines[end]?.bbox.y??page.height))removed.add(item);
      if(end===lines.length){context.issues.push('context_boundary_unresolved');pending=context;}
      contexts.push(context);start=end-1;
    }
    output.push({...page,items:page.items.filter(item=>!removed.has(item))});
  }
  for(const context of contexts)context.evidenceHash=createHash('sha256').update(JSON.stringify(contextEvidencePayload(context))).digest('hex');
  return {pages:output,contexts};
}
export function contextEvidencePayload(context: SharedContextEvidence) {
  return {originalText:context.originalText,rawLayout:context.rawLayout,rawPageLayout:context.rawPageLayout,rawPages:context.rawPages,declaredNumbers:context.declaredNumbers,provenance:context.provenance,imageRefs:context.imageRefs};
}
