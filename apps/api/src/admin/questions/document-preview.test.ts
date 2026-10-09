import {beforeEach,describe,expect,it,vi} from 'vitest';
import {readPdfLayout,readPdfPageGeometry} from '@remoa/ai';
import {prepareDocument,questionRegionPreview} from './service';
import {sha256} from '../../questions/imports/domain';
import {putBytes,getBytes,headObject,presignGet} from '../../storage/storage';
import {renderQuestionCrop} from '../../questions/pdf';
const fixture=new TextEncoder().encode('%PDF-1.7 synthetic');
vi.mock('../../db',()=>({dbm:async()=>({questionSourcesCatalog:{id:'source'},db:{select:()=>({from:()=>({where:async()=>[{id:'source'}]})})}})}));
vi.mock('@remoa/ai',()=>({readPdfLayout:vi.fn(),readPdfPageGeometry:vi.fn()}));
vi.mock('../../storage/storage',()=>({putBytes:vi.fn(async()=>{}),getBytes:vi.fn(),headObject:vi.fn(),presignGet:vi.fn(),deleteObject:vi.fn(async()=>{})}));
vi.mock('../../questions/pdf',()=>({renderQuestionCrop:vi.fn()}));
const layout=vi.mocked(readPdfLayout),geometry=vi.mocked(readPdfPageGeometry);
beforeEach(()=>{
 vi.clearAllMocks();layout.mockResolvedValue({pages:[{page:1,width:600,height:800,items:[],ocrRequiredReason:'font_metrics_nonfinite'}]});
 geometry.mockResolvedValue({page:2,width:800,height:600,totalPages:38});
 vi.mocked(getBytes).mockResolvedValue(Buffer.from(fixture));vi.mocked(headObject).mockResolvedValue(null);
 vi.mocked(renderQuestionCrop).mockResolvedValue(new Uint8Array([1,2,3]));vi.mocked(presignGet).mockResolvedValue('https://example.org/private.png');
});
const metadata=()=>({objectKey:'questions/documents/actor/exam.pdf',sha256:sha256(fixture),payload:{provenance:[{page:2,bbox:{x:10,y:20,width:100,height:50}}]}});
describe('PDF upload preparation and private region preview',()=>{
 it('upload opts into font-metric staging without OCR and persists only the validated PDF',async()=>{
  const result=await prepareDocument('actor','source','exam',fixture);
  expect(result).toMatchObject({ok:true,data:{pages:1,sha256:sha256(fixture)}});
  expect(layout).toHaveBeenCalledWith(fixture,{allowFontMetricOcr:true});
  expect(putBytes).toHaveBeenCalledOnce();expect(geometry).not.toHaveBeenCalled();expect(renderQuestionCrop).not.toHaveBeenCalled();
 });
 it('malformed later geometry after a bad font remains a validation failure before storage',async()=>{
  layout.mockRejectedValueOnce(Object.assign(Error('pdf_invalid_geometry'),{code:'pdf_invalid_geometry'}));
  expect(await prepareDocument('actor','source','exam',fixture)).toMatchObject({ok:false,error:{code:'validation'}});
  expect(putBytes).not.toHaveBeenCalled();
 });
 it.each([0,501])('rejects document page count %s before storage',async pages=>{
  layout.mockResolvedValueOnce({pages:Array.from({length:pages},()=>({page:1,width:600,height:800,items:[]}))});
  const result=await prepareDocument('actor','source','exam',fixture);expect(result.ok).toBe(false);expect(putBytes).not.toHaveBeenCalled();
 });
 it('preview opens only the requested page with its rotated geometry and unchanged source bbox',async()=>{
  const meta=metadata();expect(await questionRegionPreview('import','candidate',meta)).toMatchObject({id:'candidate',expiresInSec:3600});
  expect(geometry).toHaveBeenCalledWith(expect.any(Uint8Array),2);expect(layout).not.toHaveBeenCalled();
  expect(renderQuestionCrop).toHaveBeenCalledWith(expect.any(Uint8Array),{page:2,width:800,height:600,totalPages:38,items:[]},meta.payload.provenance[0]!.bbox,100);
 });
 it('preview cache hit avoids reading PDF or rendering again',async()=>{
  vi.mocked(headObject).mockResolvedValueOnce({size:3,mime:'image/png'});
  await questionRegionPreview('import','candidate',metadata());
  expect(getBytes).not.toHaveBeenCalled();expect(geometry).not.toHaveBeenCalled();expect(putBytes).not.toHaveBeenCalled();
 });
 it('preview rejects a changed source hash before opening any page',async()=>{
  await expect(questionRegionPreview('import','candidate',{...metadata(),sha256:'0'.repeat(64)})).rejects.toThrow('document_hash_mismatch');
  expect(geometry).not.toHaveBeenCalled();expect(putBytes).not.toHaveBeenCalled();
 });
 it.each(['pdf_invalid_geometry','pdf_too_many_pages','pdf_invalid_page'])('preview respects geometry helper failure %s without rendering/storage',async code=>{
  geometry.mockRejectedValueOnce(Object.assign(Error(code),{code}));
  await expect(questionRegionPreview('import','candidate',metadata())).rejects.toThrow(code);
  expect(renderQuestionCrop).not.toHaveBeenCalled();expect(putBytes).not.toHaveBeenCalled();
 });
});
