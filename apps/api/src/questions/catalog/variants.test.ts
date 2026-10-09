import { describe,expect,it } from 'vitest';
import { applyOccurrence } from './service';
import { shuffleQuestion } from '../sessions/service';
import { mockCatalogQuestion } from '@remoa/contracts/mocks';
import type { QuestionReferenceAfterAnswer } from '@remoa/contracts';
describe('booklet and shuffled alternatives',()=>{
  const alternatives=['A','B','C','D','E'].map(key=>({key,text:'Synthetic '+key}));
  const original=alternatives.map((a,i)=>({...a,key:['E','D','C','B','A'][i]!}));
  const row={alternatives,correct_key:'E',original_keys:{alternatives:original,correctKey:'A'},distractor_notes:{A:'Synthetic note A'},availability:'active'};
  it('keeps original booklet order and translates canonical notes by content',()=>{
    const variant=applyOccurrence(row);expect(variant.alternatives).toEqual(original);expect(variant.correct_key).toBe('A');expect(variant.distractor_notes).toEqual({E:'Synthetic note A'});
  });
  it('rejects a changed text or incorrect variant key',()=>{
    expect(()=>applyOccurrence({...row,original_keys:{alternatives:original,correctKey:'B'}})).toThrow();
    expect(()=>applyOccurrence({...row,original_keys:{alternatives:[{key:'A',text:'invented'},...original.slice(1)],correctKey:'A'}})).toThrow();
  });
  it('shuffles all five keys without changing the semantic answer or exposing its mapping',()=>{
    const ref:QuestionReferenceAfterAnswer={questionId:mockCatalogQuestion.id,version:1,correctKey:'E',explanation:null,distractorNotes:null,annulled:false,reviewed:false,reviewerName:null,reviewerCrm:null,referenceDate:null,sourceUrl:null,obsolete:false};
    const result=shuffleQuestion(mockCatalogQuestion,ref);expect((result.map as Record<string,string>)[result.reference.correctKey!]).toBe('E');expect(result.question.alternatives?.map(a=>a.key)).toEqual(['A','B','C','D','E']);expect(Object.keys(result.question)).not.toContain('map');
  });
});
