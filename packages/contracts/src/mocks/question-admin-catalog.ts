import { questionAdminCatalogPageSchema, questionVersionHistoryPageSchema, questionReviewHistoryPageSchema, questionSessionsPageResultSchema, questionImportPageResultSchema } from '../question-admin-catalog';
import { mockQuestionSessionSummary, mockQuestionImportProgress } from './question-catalog';
const id='33000000-0000-4000-8000-000000000001';
const createdAt='2026-10-09T12:00:00.000Z';
/** Engineering metadata, no medical approval. */
export const mockQuestionAdminCatalogPage=questionAdminCatalogPageSchema.parse({items:[{id,canonicalId:id,supersedesId:null,version:1,type:'objective',origin:'official_exam',stemPreview:'Questão sintética de navegação.',catalogStatus:'in_review',rightsStatus:'pending',availability:'active',sourceId:null,sourceLabel:null,contentHash:'a'.repeat(64),reviewedHash:null,createdAt,updatedAt:createdAt,publishedAt:null}],nextCursor:null});
export const mockQuestionVersionHistoryPage=questionVersionHistoryPageSchema.parse({questionId:id,canonicalId:id,items:mockQuestionAdminCatalogPage.items,nextCursor:null});
export const mockQuestionReviewHistoryPage=questionReviewHistoryPageSchema.parse({questionId:id,items:[],nextCursor:null});
export const mockQuestionSessionsPage=questionSessionsPageResultSchema.parse({items:[mockQuestionSessionSummary],nextCursor:null});

const audit={id:1,createdAt,actorType:'admin',actor:null,action:'question.import_view',targetType:'route',targetId:'/v1/admin/questions/imports/page',targetLabel:null,reason:'Consultar importações sintéticas',result:'success',denial:null,before:null,after:null,ipHash:null,userAgent:null,requestId:null};
export const mockQuestionImportPage=questionImportPageResultSchema.parse({items:[mockQuestionImportProgress],nextCursor:null,audit});
