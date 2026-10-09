import { randomUUID as uuid } from 'node:crypto';
import { describe,it,expect } from 'vitest';
import { answerOutcome,compareSessionItem } from './recalculation';
const original=uuid(),next=uuid(),item=uuid();
const choices=[{key:'A',text:'Synthetic 1 mg'},{key:'B',text:'Synthetic 2 mg'}];
const frozen=()=>({id:item,question_id:original,payload_public:{id:original,version:1,type:'objective',stem:'Synthetic stem',alternatives:choices},reference_snapshot:{version:1,correctKey:'A',annulled:false},answered:true,selected_key:'A'});
const current=()=>({id:original,version:1,type:'objective',stem:'Synthetic stem',alternatives:choices,correct_key:'A',availability:'active',visibility:'private'});
describe('CCR116 semantic comparison and explicit uncertainty',()=>{
 it('distinguishes explicit uncertainty from untouched items and excludes annulled items',()=>{
  expect(answerOutcome(true,null,'A',false)).toBe('incorrect');expect(answerOutcome(false,null,'A',false)).toBe('unanswered');expect(answerOutcome(true,'A','A',false)).toBe('correct');expect(answerOutcome(true,'B','A',false)).toBe('incorrect');expect(answerOutcome(true,null,null,true)).toBe('annulled');
 });
 it('compares the saved displayed alternative text even when keys shuffle across versions',()=>{
  const r=compareSessionItem(frozen(),{...current(),id:next,version:2,alternatives:[{key:'A',text:choices[1]!.text},{key:'B',text:choices[0]!.text}],correct_key:'B'});
  expect(r).toMatchObject({outcome:'correct',reasonCode:'version_changed',originalQuestionVersion:1,comparedQuestionVersion:2});expect(r.reference?.correctKey).toBe('B');
 });
 it('reports semantic key rectification separately without mutating frozen inputs',()=>{
  const input=frozen(),before=JSON.stringify(input),r=compareSessionItem(input,{...current(),id:next,version:2,correct_key:'B'});
  expect(r).toMatchObject({outcome:'incorrect',reasonCode:'key_changed'});expect(JSON.stringify(input)).toBe(before);
 });
 it('uses NFC and whitespace only; preserves dose, negation and case',()=>{
  expect(compareSessionItem(frozen(),{...current(),stem:'  Synthetic   stem ',alternatives:choices.map(a=>({...a,text:a.text+' '}))}).outcome).toBe('correct');
  for(const q of [{...current(),stem:'Synthetic NOT stem'},{...current(),stem:'synthetic stem'},{...current(),alternatives:[{key:'A',text:'Synthetic 10 mg'},choices[1]!]}])expect(compareSessionItem(frozen(),q)).toMatchObject({outcome:'not_comparable',reference:null,reasonCode:'content_not_comparable'});
 });
 it('hides unavailable references and never guesses malformed or duplicate alternatives',()=>{
  expect(compareSessionItem(frozen())).toMatchObject({outcome:'unavailable',reference:null,comparedQuestionId:null,reasonCode:'rights_unavailable'});
  for(const a of [null,[],[{key:'A',text:'same'},{key:'B',text:'same'}],[{key:'A',text:'One'},{key:'A',text:'Two'}],[{key:'A',text:''},{key:'B',text:'Two'}],[{key:1,text:'One'},{key:'B',text:'Two'}]])expect(compareSessionItem(frozen(),{...current(),alternatives:a})).toMatchObject({outcome:'not_comparable',reference:null});
  expect(compareSessionItem({...frozen(),selected_key:'Z'},current()).outcome).toBe('not_comparable');expect(compareSessionItem(frozen(),{...current(),correct_key:'Z'}).outcome).toBe('not_comparable');expect(compareSessionItem(frozen(),{...current(),correct_key:null}).outcome).toBe('not_comparable');
 });
 it('compares image identity, alt and provenance while ignoring signed URL TTL changes',()=>{
  const asset={id:uuid(),alt:'Synthetic figure',objectKey:'questions/imports/hash/image.png',provenance:{page:1,bbox:{x:0,y:0,width:1,height:1}}},input={...frozen(),payload_public:{...frozen().payload_public,assets:[{...asset,url:'https://example.org/image?expires=1'}]}};
  expect(compareSessionItem(input,{...current(),assets:[{...asset,url:'https://example.org/image?expires=2'}]}).outcome).toBe('correct');
  for(const changed of [{...asset,objectKey:'questions/imports/new/image.png'},{...asset,alt:'Different clinical image'},{...asset,provenance:{page:2}}])expect(compareSessionItem(input,{...current(),assets:[changed]})).toMatchObject({outcome:'not_comparable',reference:null});
  expect(compareSessionItem(input,{...current(),assets:[{}]}).outcome).toBe('not_comparable');
 });
 it('keeps unchanged outcomes, explicit uncertainty and original occurrence annulment distinct',()=>{
  expect(compareSessionItem(frozen(),current())).toMatchObject({outcome:'correct',reasonCode:'unchanged'});
  expect(compareSessionItem({...frozen(),selected_key:null},current()).outcome).toBe('incorrect');expect(compareSessionItem({...frozen(),answered:false,selected_key:null},current()).outcome).toBe('unanswered');
  expect(compareSessionItem(frozen(),{...current(),id:next,version:2,availability:'annulled',correct_key:null})).toMatchObject({outcome:'annulled',reasonCode:'annulled'});
  expect(compareSessionItem({...frozen(),reference_snapshot:{version:1,correctKey:null,annulled:true}},current()).outcome).toBe('annulled');
 });
});
