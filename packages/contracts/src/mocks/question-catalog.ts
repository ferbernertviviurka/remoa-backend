import { questionPublicSchema, questionSessionPublicSchema, questionSessionSummaryPublicSchema, examPaperPublicSchema,questionImportContextSchema,questionImportProgressSchema } from '../question-catalog';
const id = '33000000-0000-4000-8000-000000000001';
/** Synthetic content, no medical claim or real editorial attribution. */
export const mockCatalogQuestion = questionPublicSchema.parse({ id, canonicalId: id, version: 1, type: 'objective', stem: 'Questão sintética de demonstração: escolha a alternativa E.', alternatives: ['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, text: `Alternativa ${key}` })), origin: 'ai_generated', visibility: 'private', availability: 'active', difficulty: 'medium', topicId: null, areaId: null, sourceId: null, sourceLabel: null, occurrences:{items:[],total:0,truncated:false}, reviewed: false, assets: [], cardIds: [], createdAt: '2026-10-08T12:00:00.000Z' });
export const mockQuestionSession = questionSessionPublicSchema.parse({ id, mode: 'simulation', status: 'active', revision: 0, startedAt: '2026-10-08T12:00:00.000Z', deadline: null, finishedAt: null, serverTime: '2026-10-08T12:00:00.000Z', items: [{ id, position: 0, question: mockCatalogQuestion, originalNumber: '1', selectedKey: null, answered: false, doubtful: false, revision: 0 }] });
export const mockExamPaper = examPaperPublicSchema.parse({ id, name: 'Prova sintética', institution: 'Demonstração', year: 2026, edition: 'Exemplo', booklet: 'A', sourceId: id, version: 1, durationSec: null, questionCount: 1, status: 'draft' });

export const mockQuestionSessionSummary=questionSessionSummaryPublicSchema.parse({...Object.fromEntries(Object.entries(mockQuestionSession).filter(([key])=>key!=='items')),count:mockQuestionSession.items.length,answeredCount:0});

/** CCR130 engineering fixtures, no institutional/medical publication. */
const contextBase={id,importId:id,documentId:id,evidenceHash:'a'.repeat(64),evidenceObjectKey:`questions/imports/${id}/contexts/synthetic.json`,originalText:'Contexto sintético compartilhado.',declaredNumbers:[1,2],provenance:[{documentId:id,page:1,bbox:[0,0,1,0.4]}],imageRefs:[],revision:0,status:'unresolved',resolution:null,resolutionHash:null,createdAt:'2026-10-08T12:00:00.000Z',updatedAt:'2026-10-08T12:00:00.000Z'};
export const mockQuestionImportContextUnresolved=questionImportContextSchema.parse(contextBase);
export const mockQuestionImportContextBound=questionImportContextSchema.parse({...contextBase,status:'bound',revision:1,resolution:{decision:'bind',targetNumbers:[1,2],text:'Contexto sintético compartilhado.',imageRefIds:[],reason:'Conferência sintética de contexto compartilhado'},resolutionHash:'b'.repeat(64)});
export const mockQuestionImportContextNonQuestion=questionImportContextSchema.parse({...contextBase,status:'non_question',revision:1,resolution:{decision:'non_question',targetNumbers:[],text:'',imageRefIds:[],reason:'Conferência sintética de instrução sem questão'},resolutionHash:'c'.repeat(64)});

/** CCR133 synthetic admin progress; original page ids are never renumbered. */
const importBase={id,revision:0,status:'review',totalPages:88,completedPages:88,candidates:100,accepted:0,rejected:0,duplicate:0,costCents:0,errorCode:null,updatedAt:'2026-10-09T12:00:00.000Z'};
export const mockQuestionImportProgress=questionImportProgressSchema.parse(importBase);
export const mockQuestionImportSelectedPages=questionImportProgressSchema.parse({...importBase,answerKeyPages:[3]});
