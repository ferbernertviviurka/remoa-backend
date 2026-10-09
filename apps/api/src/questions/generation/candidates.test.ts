import {describe,expect,it}from'vitest';
import {receiptCandidates,receivedQuestionCount,RECEIPT_MAX_CANDIDATES}from'./receipts';
describe('all producer candidates before screening',()=>{
 it.each([
  ['challenge_objective',{questoes:[{enunciado:'one'},{enunciado:'two'}]}],
  ['challenge_discursive',{perguntas:[{enunciado:'one'},{enunciado:'two'}]}],
  ['map_extract',{cards:[{question:'one',answer:'a'},{question:'two',answer:'b'}]}],
  ['summary_checklist',{secoes:[{tipo:'checklist',itens:[{texto:'one'},{texto:'two'}]},{tipo:'visao_geral',itens:[{texto:'not a question'}]}]}],
 ] as const)('%s preserves every candidate in original order', (producer,value)=>{
   const candidates=receiptCandidates('Preface\n'+JSON.stringify(value)+'\nEnd',producer);expect(candidates.map(c=>c.stem)).toEqual(['one','two']);
 });
 it('never truncates candidate payloads beyond the explicit quarantine threshold',()=>{
   const list=Array.from({length:RECEIPT_MAX_CANDIDATES+1},(_,i)=>({enunciado:String(i)}));expect(receiptCandidates(JSON.stringify({questoes:list}),'challenge_objective')).toHaveLength(list.length);
 });
 it('keeps unknown/invalid original replies in quarantine without pretending they are validated questions',()=>{
   expect(receiptCandidates('malformed','challenge_objective')[0]?.reason).toBe('invalid_json');expect(receiptCandidates('{"different":"shape"}','map_extract')[0]?.reason).toBe('no_candidates_or_unknown_shape');
 });
});

describe('identified question counts exclude diagnostics',()=>{
 it.each([
  ['challenge_objective','not JSON',0],['challenge_objective','{"questoes":[]}',0],['challenge_discursive','{"perguntas":[]}',0],['map_extract','{"cards":[]}',0],['summary_checklist','{"secoes":[{"tipo":"visao_geral","itens":[{"texto":"declarative"}]}]}',0],['map_extract','{}',0],['map_extract','{"cards":[null,{},false]}',3],['challenge_objective','{"questoes":[{"enunciado":"one"},null]}',2],
 ] as const)('%s %s identifies %i questions',(producer,text,count)=>{expect(receivedQuestionCount(receiptCandidates(text,producer))).toBe(count);});
});
