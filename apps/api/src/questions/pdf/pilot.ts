/** Local research only. No publishing, database writes or provider calls. */
import {readFile} from 'node:fs/promises';
import {join}from'node:path';
import {createHash}from'node:crypto';
import {readPdfPages}from'./read';
import {createTesseractOcr}from'./ocr';
import{readPdfLayout}from'@remoa/ai';
import{parseAnswerKey,parseExam}from'./parser';
interface Source {id:string;group:string;declared_item_count:number;files:{exam:{path:string};answer_key:{path:string}}}
const directory=process.argv[2];if(!directory)throw Error('Pass the local docs/content/questions directory');
const sourceFlag=process.argv.indexOf("--source");const selected=sourceFlag>=0?process.argv[sourceFlag+1]:undefined;
const fontOcr=process.argv.includes("--font-metric-ocr");
const sources=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'))as Source[];
for(const source of sources){
 if(selected&&source.id!==selected)continue;
 const examBytes=new Uint8Array(await readFile(join(directory,source.files.exam.path)));
 const excluded=fontOcr&&source.id==='fuvest-rm2024-A1'&&createHash('sha256').update(examBytes).digest('hex')==='c4e85dccff76d943df4e2c788c09739cfe279d50e26de93de0e2d44fb927cebd'?[38]:[];
 const exam=fontOcr?{pages:await readPdfPages(examBytes,{allowFontMetricOcr:true,ocr:createTesseractOcr(),reviewedNonQuestionPages:excluded})}:await readPdfLayout(examBytes);
 const key=await readPdfLayout(new Uint8Array(await readFile(join(directory,source.files.answer_key.path))));
 const entries=parseAnswerKey(key.pages,source.group);const result=parseExam(exam.pages,entries);
 const unique=new Set(result.candidates.map(c=>c.originalNumber));
 process.stdout.write(JSON.stringify({id:source.id,ocrPages:exam.pages.filter(p=>"method" in p&&p.method==="ocr").map(p=>p.page),fontMetricOcrPages:exam.pages.filter(p=>"ocrRequiredReason" in p&&p.ocrRequiredReason).map(p=>p.page),reviewedExcludedPages:excluded,declared:source.declared_item_count,detected:result.candidates.length,unique:unique.size,missing:Array.from({length:source.declared_item_count},(_,i)=>i+1).filter(i=>!unique.has(i)),lowTextPages:exam.pages.filter(p=>p.items.map(i=>i.text).join('').length<30).map(p=>p.page),keyEntries:entries.entries.length,keyProvenancePages:[...new Set(entries.entries.map(e=>e.provenance.page))],ambiguousKeys:entries.entries.filter(e=>e.ambiguous).map(e=>e.number),annulled:result.candidates.filter(c=>c.annulled).map(c=>c.originalNumber),issues:result.candidates.reduce((all,c)=>{for(const i of c.issues)all[i]=(all[i]??0)+1;return all;},{}as Record<string,number>),warnings:result.warnings})+'\n');
}
