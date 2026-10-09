import { Hono } from 'hono';
import { err,parseWith,questionAdminCatalogQuerySchema,questionHistoryQuerySchema,idSchema } from '@remoa/contracts';
import { withAdmin,send,type AdminEnv } from '../core';
import { questionFeatureGate } from '../../questions/runtime/admission';
import { catalogPage,versionHistory,reviewHistory,catalogStaff,catalogQueryValues } from '../../questions/editorial/catalog';
/** Wrapper owns one audited transaction; helpers never write a second audit. */
export const questionAdminCatalogRoutes=new Hono<AdminEnv>()
.get('/catalog',questionFeatureGate('catalog'),async c=>send(await withAdmin(c,'question.catalog_view',{reason:'Consultar catálogo administrativo de questões',target:{type:'route',id:c.req.path}},async(tx,audit)=>{
 const actor=await catalogStaff(tx,c.get('admin').id,'admin');if(!actor)return err('not_found','route not found');
 const input=parseWith(questionAdminCatalogQuerySchema,catalogQueryValues(c.req.url));if(!input.ok)return input;
 const result=await catalogPage(tx,actor,input.data,c.req.path);if(result.ok)audit.after({count:result.data.items.length,hasMore:result.data.nextCursor!==null,status:input.data.status??null,versions:input.data.versions});return result;
})))
.get('/:id/history',questionFeatureGate('catalog'),async c=>send(await withAdmin(c,'question.history_view',{reason:'Consultar versões históricas de questão institucional',target:{type:'question',id:c.req.param('id')}},async(tx,audit)=>{
 const actor=await catalogStaff(tx,c.get('admin').id,'admin');if(!actor)return err('not_found','route not found');
 const id=idSchema.safeParse(c.req.param('id'));if(!id.success)return err('not_found','question not found');
 const input=parseWith(questionHistoryQuerySchema,catalogQueryValues(c.req.url));if(!input.ok)return input;
 const result=await versionHistory(tx,actor,id.data,input.data,c.req.path);if(result.ok)audit.after({count:result.data.items.length,hasMore:result.data.nextCursor!==null});return result;
})))
.get('/:id/reviews',questionFeatureGate('catalog'),async c=>send(await withAdmin(c,'question.history_view',{reason:'Consultar assinaturas históricas de questão institucional',target:{type:'question',id:c.req.param('id')}},async(tx,audit)=>{
 const actor=await catalogStaff(tx,c.get('admin').id,'admin');if(!actor)return err('not_found','route not found');
 const id=idSchema.safeParse(c.req.param('id'));if(!id.success)return err('not_found','question not found');
 const input=parseWith(questionHistoryQuerySchema,catalogQueryValues(c.req.url));if(!input.ok)return input;
 const result=await reviewHistory(tx,actor,id.data,input.data,c.req.path);if(result.ok)audit.after({count:result.data.items.length,hasMore:result.data.nextCursor!==null});return result;
}))); 
