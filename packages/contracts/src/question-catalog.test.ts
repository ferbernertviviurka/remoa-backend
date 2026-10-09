import { describe, expect, it } from 'vitest';
import { catalogAlternativesSchema, questionAnswerInputSchema, questionPublicSchema, questionSessionConfigSchema, questionSessionPublicSchema, questionSourceInputSchema, questionCandidatePayloadSchema, QUESTION_PDF_PARSER_VERSION, questionReportQueueQuerySchema, questionReportQueueItemSchema, questionReportResolveInputSchema, questionSessionRecalculationSchema, questionInstitutionListSchema, questionListQuerySchema,questionOccurrencesSchema } from './question-catalog';
import { generatedQuestionSchema, ALTERNATIVE_KEYS } from './challenge-ai';
import { mockCatalogQuestion, mockQuestionSession } from './mocks/question-catalog';
import { questionCandidatePageImageInputSchema, questionCandidateImageRefSchema,importCandidateReviewInputSchema } from './question-catalog';
describe('F33 catalog boundary', () => {
  it.each(['pending','needs_review','rejected'])('draft state%s can remove the key without inventing an answer',state=>{
    const draft={stem:'Synthetic draft',alternatives:[{key:'A',text:'Synthetic A'},{key:'B',text:'Synthetic B'}],correctKey:null,explanation:null,topicId:null,areaId:null,annulled:false,keyFinal:false,integrityConfirmed:false,state,duplicateOf:null,revision:0,reason:'Synthetic key removal draft'};
    expect(importCandidateReviewInputSchema.safeParse(draft).success).toBe(true);
    expect(importCandidateReviewInputSchema.safeParse({...draft,correctKey:'E'}).success).toBe(false);
  });
  it.each(['accepted','duplicate'])('state%s retains the final key gate, including annulation semantics',state=>{
    const input={stem:'Synthetic acceptance',alternatives:[{key:'A',text:'Synthetic A'},{key:'B',text:'Synthetic B'}],correctKey:null,explanation:null,topicId:null,areaId:null,annulled:false,keyFinal:true,integrityConfirmed:true,state,duplicateOf:null,revision:0,reason:'Synthetic final key acceptance'};
    expect(importCandidateReviewInputSchema.safeParse(input).success).toBe(false);
    expect(importCandidateReviewInputSchema.safeParse({...input,correctKey:'A'}).success).toBe(true);
    expect(importCandidateReviewInputSchema.safeParse({...input,correctKey:'A',keyFinal:false}).success).toBe(false);
    expect(importCandidateReviewInputSchema.safeParse({...input,annulled:true}).success).toBe(true);
    expect(importCandidateReviewInputSchema.safeParse({...input,annulled:true,correctKey:'E'}).success).toBe(false);
  });
  it('manual page images require a bounded page, revision and reason and retain integrity metadata',()=>{
    const input={page:1,revision:0,reason:'Synthetic manually reviewed page'};
    expect(questionCandidatePageImageInputSchema.safeParse(input).success).toBe(true);
    for(const page of [0,501,1.5])expect(questionCandidatePageImageInputSchema.safeParse({...input,page}).success).toBe(false);
    expect(questionCandidatePageImageInputSchema.safeParse({...input,objectKey:'untrusted'}).success).toBe(false);
    const image={page:1,bbox:{x:0,y:0,width:100,height:100},method:'manual_page',objectKey:'private/synthetic',sha256:'a'.repeat(64),bytes:100};
    expect(questionCandidateImageRefSchema.safeParse(image).success).toBe(true);
    expect(questionCandidateImageRefSchema.safeParse({...image,sha256:'invalid'}).success).toBe(false);
    expect(questionCandidateImageRefSchema.safeParse({...image,bytes:0}).success).toBe(false);
  });
  it('accepts five alternatives and rejects duplicates', () => {
    expect(catalogAlternativesSchema.parse(mockCatalogQuestion.alternatives)).toHaveLength(5);
    expect(catalogAlternativesSchema.safeParse([{ key: 'A', text: 'a' }, { key: 'A', text: 'b' }]).success).toBe(false);
  });
  it.each(['correctKey', 'explanation', 'expectedAnswer', 'referenceSnapshot', 'shuffleMap'])('rejects reference field %s on public question and session', (field) => {
    expect(questionPublicSchema.safeParse({ ...mockCatalogQuestion, [field]: 'secret' }).success).toBe(false);
    expect(questionSessionPublicSchema.safeParse({ ...mockQuestionSession, [field]: 'secret' }).success).toBe(false);
  });
  it('client cannot supply correctness or score', () => {
    expect(questionAnswerInputSchema.safeParse({ selectedKey: 'E', mutationId: mockCatalogQuestion.id, revision: 0, elapsedMs: 10, correct: true }).success).toBe(false);
  });
  it('requires one selection, with no silent generated fallback', () => {
    expect(questionSessionConfigSchema.safeParse({ mode: 'study', count: 10 }).success).toBe(false);
    expect(questionSessionConfigSchema.safeParse({ mode: 'simulation', count: 10, filters: {} }).success).toBe(true);
    expect(questionSessionConfigSchema.safeParse({ mode: 'study', count: 10, filters: {}, examId: mockCatalogQuestion.id }).success).toBe(false);
  });
  it('authorized sources require evidence', () => {
    expect(questionSourceInputSchema.safeParse({ name: 'x', publisher: 'x', url: 'https://example.org', rightsStatus: 'authorized', reason: 'fixture testing' }).success).toBe(false);
  });
  it('rejects non-http source URLs and preserves invalid staging alternatives for correction', () => {
    expect(questionSourceInputSchema.safeParse({ name:'x',publisher:'x',url:'javascript:alert(1)',reason:'fixture testing' }).success).toBe(false);
    const staging=questionCandidatePayloadSchema.parse({stem:'synthetic',alternatives:[{key:'A',text:'one'},{key:'A',text:'two'}],correctKey:null,annulled:false});
    expect(staging.alternatives).toHaveLength(2);expect(staging.imagesConfirmed).toBe(false);
    expect(QUESTION_PDF_PARSER_VERSION).toBe('f33-layout-v7');
  });
  it('triage contracts exclude reporter identity and require an optimistic timestamp and audited reason',()=>{
    expect(questionReportQueueQuerySchema.parse({}).limit).toBe(30);
    expect(questionReportQueueQuerySchema.safeParse({limit:101}).success).toBe(false);
    const report={id:mockCatalogQuestion.id,questionId:mockCatalogQuestion.id,version:1,type:'key',description:'Synthetic report',status:'open',createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z'};
    expect(questionReportQueueItemSchema.safeParse({...report,userId:mockCatalogQuestion.id}).success).toBe(false);
    expect(questionReportResolveInputSchema.safeParse({status:'resolved',reason:'short',expectedUpdatedAt:report.updatedAt}).success).toBe(false);
    expect(questionReportResolveInputSchema.safeParse({status:'resolved',reason:'Synthetic audited resolution',expectedUpdatedAt:report.updatedAt}).success).toBe(true);
  });
  it('institution is distinct from an exam and options disclose truncation',()=>{
    expect(questionListQuerySchema.parse({institution:'  Synthetic institution  '}).institution).toBe('Synthetic institution');
    expect(questionListQuerySchema.safeParse({institution:'  '}).success).toBe(false);
    expect(questionInstitutionListSchema.safeParse({items:[],truncated:true}).success).toBe(true);
  });
  it('recalculation forbids a partial score or references for incomparable items',()=>{
    const item={itemId:mockCatalogQuestion.id,originalQuestionId:mockCatalogQuestion.id,originalQuestionVersion:1,comparedQuestionId:null,comparedQuestionVersion:null,outcome:'unavailable',reasonCode:'rights_unavailable',reference:null};
    const comparison={sessionId:mockCatalogQuestion.id,originalVersion:1,calculatedAt:'2026-10-08T00:00:00Z',complete:false,aggregates:null,items:[item]};
    expect(questionSessionRecalculationSchema.safeParse(comparison).success).toBe(true);
    expect(questionSessionRecalculationSchema.safeParse({...comparison,aggregates:{correct:1,incorrect:0,unanswered:0,annulled:0,denominator:1,score:1}}).success).toBe(false);
    expect(questionSessionRecalculationSchema.safeParse({...comparison,complete:true}).success).toBe(false);
  });
  it('F32 generator remains A–D and four alternatives', () => {
    expect(ALTERNATIVE_KEYS).toEqual(['A', 'B', 'C', 'D']);
    const q = { tipo: 'objetiva', dificuldade: 'medio', enunciado: 'synthetic', alternativas: mockCatalogQuestion.alternatives?.map((a) => ({ letra: a.key, texto: a.text })), correta: 'E', resposta_esperada: 'E', pontos_essenciais: ['x'], explicacao: '', notas_distratores: null, evidencias: [{ card: mockCatalogQuestion.id, trecho: 'synthetic' }], tema: null };
    expect(generatedQuestionSchema.safeParse(q).success).toBe(false);
  });
});

it('booklet provenance is bounded, reports its total, and cannot carry a key',()=>{
 const occurrence={examId:mockCatalogQuestion.id,name:'Synthetic exam',institution:'Synthetic institution',year:2026,edition:'2026',booklet:'A',ordinal:1,originalNumber:'42',sourceId:mockCatalogQuestion.id,sourceLabel:'Synthetic source'};
 expect(questionOccurrencesSchema.safeParse({items:Array(10).fill(occurrence),total:12,truncated:true}).success).toBe(true);
 expect(questionOccurrencesSchema.safeParse({items:Array(11).fill(occurrence),total:12,truncated:true}).success).toBe(false);
 expect(questionOccurrencesSchema.safeParse({items:[{...occurrence,correctKey:'A'}],total:1,truncated:false}).success).toBe(false);
 expect(questionOccurrencesSchema.safeParse({items:[occurrence],total:12,truncated:false}).success).toBe(false);
});
