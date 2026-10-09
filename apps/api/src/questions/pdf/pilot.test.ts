import{readFile}from'node:fs/promises';
import{fileURLToPath}from'node:url';
import{describe,expect,it}from'vitest';
import{readPdfLayout}from'@remoa/ai';
import{parseAnswerKey,parseExam}from'./parser';
import{readPdfQuestions}from'./read';
import{createTesseractOcr,renderQuestionCrop}from'./ocr';
const sources=fileURLToPath(new URL('../../../../../../docs/content/questions/pdfs/',import.meta.url));
describe.runIf(process.env['PARSER_PDF_PILOT']==='1')('local official PDFs: structural regression, not medical validation',()=>{
 it('reads AD1 compressed real PDF, preserves120 numbers/options and ambiguous revised keys',async()=>{
 const exam=new Uint8Array(await readFile(`${sources}rm2026-prova-AD1-areasbasicas-acessodireto.pdf`));
 const key=new Uint8Array(await readFile(`${sources}rm2026-gabarito-AD-areasbasicas-acessodireto-retificado.pdf`));
 // Pages39/40 are visually verified draft watermark-only sheets, explicit operator exclusions.
 const result=await readPdfQuestions(exam,{answerKeyBytes:key,group:'AD1',reviewedNonQuestionPages:[39,40]});
 expect(result.candidates.map(c=>c.originalNumber)).toEqual(Array.from({length:120},(_,i)=>i+1));
 expect(result.candidates.every(c=>c.alternatives.length===4 && c.status==='staging')).toBe(true);
 expect(result.answerKey?.entries.filter(e=>e.ambiguous).map(e=>e.number)).toEqual([109,110,114]);
 expect(result.candidates.filter(c=>c.annulled).map(c=>c.originalNumber)).toEqual([54,120]);
 expect(result.candidates[0]?.imageRefs.length).toBeGreaterThan(0);
 expect(result.warnings).toEqual(['reviewed_non_question_page:39','reviewed_non_question_page:40']);
 },20000);
 it('parses second group ECM without losing numbers; revisions remain staging ambiguity',async()=>{
 const exam=await readPdfLayout(new Uint8Array(await readFile(`${sources}rm2026-prova-ECM-especialidades-clinicas.pdf`)));
 const key=await readPdfLayout(new Uint8Array(await readFile(`${sources}rm2026-gabarito-ECM-especialidades-clinicas-retificado.pdf`)));
 const entries=parseAnswerKey(key.pages,'ECM'),result=parseExam(exam.pages,entries);
 expect(result.candidates.map(c=>c.originalNumber)).toEqual(Array.from({length:120},(_,i)=>i+1));expect(entries.entries).toHaveLength(120);expect(entries.entries.filter(e=>e.ambiguous).map(e=>e.number)).toEqual([2,7,14,100]);
 },20000);
 it('renders a real review crop through Poppler without exposing external URLs',async()=>{
 const bytes=new Uint8Array(await readFile(`${sources}rm2026-prova-AD1-areasbasicas-acessodireto.pdf`));
 const cropped=await renderQuestionCrop(bytes,{page:3,width:595,height:842,items:[]},{x:37,y:65,width:520,height:650},72);
 expect(Array.from(cropped.slice(0,8))).toEqual([137,80,78,71,13,10,26,10]);
 },20000);
 it('executes real Tesseract OCR with explicitly selected installed English test language',async()=>{
 const bytes=new Uint8Array(await readFile(`${sources}rm2026-prova-AD1-areasbasicas-acessodireto.pdf`));
 const page=await createTesseractOcr({language:'eng',dpi:120}).readPage(bytes,{page:3,width:595,height:842,items:[]});
 expect(page.method).toBe('ocr');expect(page.items.length).toBeGreaterThan(30);
 // This verifies worker execution only; language/medical accuracy is not approved by this assertion.
 },20000);
});
