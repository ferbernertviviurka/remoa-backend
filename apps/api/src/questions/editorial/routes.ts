import { Hono,type Context } from 'hono';
import { err,parseWith,questionAdminCatalogQuerySchema,questionHistoryQuerySchema,idSchema, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import type { Env } from '../../app';
import { dbm,Abort } from '../../db';
import { send,writeAudit,auditMeta } from '../../admin/core';
import { questionFeatureGate } from '../runtime/admission';
import { catalogPage,versionHistory,reviewHistory,catalogStaff,catalogQueryValues,type CatalogActor } from './catalog';
async function read<T extends {items:unknown[];nextCursor:string|null}>(c:Context<Env>,history:boolean,fn:(tx:Tx,actor:CatalogActor)=>Promise<Result<T>>){
 const {db}=await dbm();try{return await db.transaction(async tx=>{
  const actor=await catalogStaff(tx,c.get('userId'));if(!actor)return err('not_found','route not found');
  const result=await fn(tx,actor);if(!result.ok)throw new Abort(result.error);
  await writeAudit({...auditMeta(c),actorType:'user',actorId:actor.id,action:history?'question.history_view':'question.catalog_view',targetType:'route',targetId:c.req.path,reason:history?'Consultar histórico editorial institucional':'Consultar catálogo editorial institucional',result:'success',after:{count:result.data.items.length,hasMore:result.data.nextCursor!==null}},tx);
  return result;
 });}catch(e){if(e instanceof Abort)return {ok:false as const,error:e.error};throw e;}
}
export const questionEditorialCatalogRoutes=new Hono<Env>()
.get('/catalog',questionFeatureGate('catalog'),async c=>send(await read(c,false,async(tx,actor)=>{
 const input=parseWith(questionAdminCatalogQuerySchema,catalogQueryValues(c.req.url));return input.ok?catalogPage(tx,actor,input.data,c.req.path):input;
})))
.get('/:id/history',questionFeatureGate('catalog'),async c=>send(await read(c,true,async(tx,actor)=>{
 const id=idSchema.safeParse(c.req.param('id'));if(!id.success)return err('not_found','question not found');
 const input=parseWith(questionHistoryQuerySchema,catalogQueryValues(c.req.url));return input.ok?versionHistory(tx,actor,id.data,input.data,c.req.path):input;
})))
.get('/:id/reviews',questionFeatureGate('catalog'),async c=>send(await read(c,true,async(tx,actor)=>{
 const id=idSchema.safeParse(c.req.param('id'));if(!id.success)return err('not_found','question not found');
 const input=parseWith(questionHistoryQuerySchema,catalogQueryValues(c.req.url));return input.ok?reviewHistory(tx,actor,id.data,input.data,c.req.path):input;
})));
