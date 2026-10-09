/** Read-only pilot diagnostic: pnpm --filter @remoa/api exec tsx src/questions/pdf/diagnostic.ts <exam.pdf> <key.pdf> <group> */
import { readFile } from 'node:fs/promises';
import { readPdfQuestions } from './read';
const [exam,key,group,excluded]=process.argv.slice(2);
const reviewedNonQuestionPages=excluded?excluded.split(',').map(Number):undefined;
if(!exam||!key)throw new Error('Expected exam PDF, answer-key PDF and optional group');
const result=await readPdfQuestions(new Uint8Array(await readFile(exam)),{answerKeyBytes:new Uint8Array(await readFile(key)),group,reviewedNonQuestionPages});
const counts:Record<string,number>={};for(const c of result.candidates)for(const issue of c.issues)counts[issue]=(counts[issue]??0)+1;
process.stdout.write(JSON.stringify({parserVersion:result.parserVersion,pages:result.pages,candidates:result.candidates.length,numbers:result.candidates.map(c=>c.originalNumber),answerKeyEntries:result.answerKey?.entries.length??0,answerKeyAmbiguous:result.answerKey?.entries.filter(e=>e.ambiguous).map(e=>e.number),annulled:result.candidates.filter(c=>c.annulled).map(c=>c.originalNumber),alternativeCounts:result.candidates.reduce((a,c)=>({...a,[c.alternatives.length]:(a[c.alternatives.length]??0)+1}),{} as Record<number,number>),issues:counts,warnings:result.warnings},null,2)+'\n');
