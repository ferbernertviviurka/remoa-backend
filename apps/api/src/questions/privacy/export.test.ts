import { randomUUID as uuid } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { finishQuestionExport,isOwnedAssetKey,isOwnedRawKey,personalQuestionPrefix } from './export';
const owner=uuid(),run=uuid(),question=uuid(),now=new Date();
const key=`questions/generation/${owner}/${run}/receipt.json`;
const data=()=>({ownedQuestions:[{id:question,userId:owner,canonicalId:question,version:1,visibility:'private',origin:'ai_generated',boardId:null,type:'objective',stem:'Own question',alternatives:null,correctKey:null,expectedAnswer:'Own answer',explanation:null,keyPoints:[],createdAt:now,updatedAt:now,rawAssets:[]}],generationReceipts:[{id:run,userId:owner,producer:'synthetic',status:'received',model:'test',provider:'test',promptId:'test',promptVersion:'1',boardId:null,boardVersion:null,receivedCount:1,receiptText:null,costCents:1,errorCode:null,createdAt:now,rawKey:key}],candidates:[{id:uuid(),runId:run,ordinal:0,state:'accepted',reasonCode:null,questionId:question,rawKey:key}],sessions:[],answers:[],userStates:[],reports:[]});
const storage=()=>({head:vi.fn(async()=>({size:1,mime:'application/json'})),sign:vi.fn(async(k:string)=>'https://private.example/'+k)});
describe('personal export storage boundary',()=>{
 it('checks exact owner namespace, traversal and control characters',()=>{
  expect(personalQuestionPrefix(owner)).toBe(`questions/generation/${owner}/`);expect(isOwnedRawKey(owner,run,key)).toBe(true);
  for(const k of [key.replace(owner,uuid()),key.replace(run,uuid()),key+'/../data',key+'/./data',key+'//data',key+'\\x',key+'\n'])expect(isOwnedRawKey(owner,run,k)).toBe(false);
  expect(isOwnedAssetKey(owner,`assets/${owner}/asset`)).toBe(true);expect(isOwnedAssetKey(owner,`uploads/${owner}/asset`)).toBe(true);expect(isOwnedAssetKey(owner,key)).toBe(true);expect(isOwnedAssetKey(owner,`questions/documents/${owner}/file`)).toBe(false);expect(isOwnedAssetKey(owner,`assets/${owner}/../file`)).toBe(false);
 });
 it('signs duplicate receipt/candidate only once with expiry, exports own assets without keys',async()=>{
  const d=data(),port=storage(),asset=`assets/${owner}/personal.png`;d.ownedQuestions[0]!.rawAssets=[{id:uuid(),alt:'Own image',objectKey:asset}] as never[];
  const out=await finishQuestionExport(d,owner,port);expect(port.sign).toHaveBeenCalledTimes(2);expect(out.generationReceipts[0]?.rawDownload).toEqual(out.generationReceipts[0]?.candidates[0]?.rawDownload);
  expect(out.generationReceipts[0]!.rawDownload!.expiresAt.getTime()-Date.now()).toBeGreaterThan(3590_000);expect(JSON.stringify(out.ownedQuestions)).not.toContain('objectKey');expect(out.ownedQuestions[0]?.assets[0]?.download?.url).toContain(asset);
 });
 it('null persisted receipt stays null, storage missing and foreign keys fail visibly',async()=>{
  const d=data();d.generationReceipts[0]!.rawKey=null as unknown as string;d.candidates=[];expect((await finishQuestionExport(d,owner,storage())).generationReceipts[0]?.rawDownload).toBeNull();
  await expect(finishQuestionExport(data(),owner,{...storage(),head:async()=>null})).rejects.toThrow('question_export_raw_missing');
  const wrong=data();wrong.generationReceipts[0]!.rawKey=key.replace(owner,uuid());await expect(finishQuestionExport(wrong,owner,storage())).rejects.toThrow('question_export_raw_owner_mismatch');
  const bad=data();bad.ownedQuestions[0]!.rawAssets=[{id:uuid(),alt:'Foreign',objectKey:'questions/imports/private'}] as never[];await expect(finishQuestionExport(bad,owner,storage())).rejects.toThrow('question_export_asset_owner_mismatch');
  const absent=data();absent.candidates=[];absent.generationReceipts[0]!.rawKey=null as unknown as string;absent.ownedQuestions[0]!.rawAssets=[{id:uuid(),alt:'Own',objectKey:`uploads/${owner}/missing`}] as never[];await expect(finishQuestionExport(absent,owner,{...storage(),head:async()=>null})).rejects.toThrow('question_export_asset_missing');
  await expect(finishQuestionExport(data(),owner,{...storage(),head:async()=>{throw Error('private provider diagnostic');}})).rejects.toThrow('question_export_storage_unavailable');
  await expect(finishQuestionExport(data(),owner,{...storage(),sign:async()=>{throw Error('storage unavailable');}})).rejects.toThrow('question_export_storage_unavailable');
 });
});
