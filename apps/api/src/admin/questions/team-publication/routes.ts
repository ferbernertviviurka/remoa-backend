import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { err,parseWith,questionTeamCreateInputSchema,questionTeamItemsInputSchema,questionTeamAssetsInputSchema,questionTeamActivateInputSchema,type Result } from '@remoa/contracts';
import { withAdmin,reasonOf,send,type AdminEnv } from '../../core';
import { invalidate } from '../../../cache';
import { approveBatchSources,activateBatch,batchStatus,createBatch,importItems,uploadAssets,verifyActivationAssets,type AssetProof } from './service';
const read=(c:{req:{json():Promise<unknown>}})=>c.req.json().catch(()=>null);
async function guarded<T>(fn:()=>Promise<Result<T>>):Promise<Result<T>>{try{return await fn();}catch(e){if(e instanceof Error&&/^team_/.test(e.message))return err('conflict',e.message);throw e;}}
/** Mounted inside requireAdmin/adminRateLimit, before legacy import admissions. One withAdmin audit per operation. */
export const questionTeamPublicationRoutes=new Hono<AdminEnv>()
.use('*',bodyLimit({maxSize:72*1024*1024,onError:()=>send(err('validation','team_body_too_large'))}))
.get('/status',async c=>send(await withAdmin(c,'question.import_view',{reason:'Conferir publicação do acervo declarado pelo time Remoa',target:{type:'route',id:c.req.path}},(tx,audit)=>batchStatus(tx,audit))))
.post('/batches',async c=>{const json=await read(c);return send(await withAdmin(c,'question.team_batch_create',{reason:reasonOf(json),target:{type:'route',id:c.req.path}},(tx,audit)=>{const input=parseWith(questionTeamCreateInputSchema,json);return input.ok?guarded(()=>createBatch(tx,c.get('admin').id,audit)):Promise.resolve(input);}));})
// Uses the existing source-update audit action and the authenticated actor, never a caller-supplied identity.
.post('/sources/approve',async c=>{
 const json=await read(c);const result=await withAdmin(c,'question.source_update',{reason:reasonOf(json),target:{type:'route',id:c.req.path}},(tx,audit)=>{
  const input=parseWith(questionTeamCreateInputSchema,json);return input.ok?guarded(()=>approveBatchSources(tx,c.get('admin').id,input.data,audit)):Promise.resolve(input);
 });if(result.ok)await invalidate('question.changed',{userId:c.get('admin').id});return send(result);
})
.post('/assets',async c=>{const json=await read(c);return send(await withAdmin(c,'question.team_assets_upload',{reason:reasonOf(json),target:{type:'route',id:c.req.path}},(tx,audit)=>{const input=parseWith(questionTeamAssetsInputSchema,json);return input.ok?guarded(()=>uploadAssets(tx,c.get('admin').id,input.data,audit)):Promise.resolve(input);}));})
.post('/items',async c=>{const json=await read(c);const result=await withAdmin(c,'question.team_items_import',{reason:reasonOf(json),target:{type:'route',id:c.req.path}},(tx,audit)=>{const input=parseWith(questionTeamItemsInputSchema,json);return input.ok?guarded(()=>importItems(tx,c.get('admin').id,input.data,audit)):Promise.resolve(input);});if(result.ok)await invalidate('question.changed',{userId:c.get('admin').id});return send(result);})
// requireAdmin has authenticated the actor before the bounded storage readback starts.
.post('/activate',async c=>{
 const json=await read(c),input=parseWith(questionTeamActivateInputSchema,json);let proof:AssetProof|undefined,preflightError:Error|undefined;
 if(input.ok){try{proof=await verifyActivationAssets();}catch{preflightError=Error('team_asset_preflight_failed');}}
 const result=await withAdmin(c,'question.team_activate',{reason:reasonOf(json),target:{type:'route',id:c.req.path}},(tx,audit)=>{
  if(!input.ok)return Promise.resolve(input);
  return guarded(()=>{if(preflightError)throw preflightError;return activateBatch(tx,c.get('admin').id,audit,proof);});
 });
 if(result.ok)await invalidate('question.changed',{userId:c.get('admin').id});return send(result);
});
