import {beforeEach,describe,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({version:'f33-layout-v1'}));
vi.mock('../../db',()=>({dbm:async()=>{
 const meta={candidate:{revision:1,provenance:[{documentId:'doc',page:1}],payload:{imageRefs:[]}},job:{revision:0,status:'review',parserVersion:fixture.version,documentId:'doc',excludedPages:[]},document:{id:'doc',kind:'exam',sourceId:'source',pages:1},source:{id:'source',rightsStatus:'pending',rightsExpiresAt:null},paper:null,question:null};
 const chain={from:()=>chain,innerJoin:()=>chain,leftJoin:()=>chain,where:async()=>[meta]};
 return {db:{select:()=>chain},questionImportCandidates:{id:'c.id',importId:'c.import'},questionImports:{id:'i.id',documentId:'i.doc',sourceId:'i.source',paperId:'i.paper'},questionDocuments:{id:'d.id'},questionSourcesCatalog:{id:'s.id'},examPapers:{id:'p.id'},questionBank:{id:'q.id'}};
}}));
import {candidatePageImageMetadata} from './service';
import {QUESTION_PDF_PARSER_VERSION} from '@remoa/contracts';
beforeEach(()=>{fixture.version='f33-layout-v1';});
describe('historical manual page review is independent from the current extraction version',()=>{
 it.each(['f33-layout-v1','f33-layout-v2','f33-layout-v3','f33-layout-v4','f33-layout-v5',QUESTION_PDF_PARSER_VERSION])('keeps reviewed %s available without parsing or relabeling',async version=>{
  fixture.version=version;const result=await candidatePageImageMetadata('import','candidate',1,1);
  expect(result).toMatchObject({ok:true,data:{job:{parserVersion:version}}});expect(fixture.version).toBe(version);
 });
 it('rejects an unknown extraction version',async()=>{
  fixture.version='f33-layout-future';expect((await candidatePageImageMetadata('import','candidate',1,1)).ok).toBe(false);
 });
});
