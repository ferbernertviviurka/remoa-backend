import { Hono } from 'hono';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { Env } from '../../app';
import { questionAdminCatalogPageSchema } from '@remoa/contracts';
const state=vi.hoisted(()=>({execute:vi.fn(),audit:vi.fn()}));
vi.mock('../../db',()=>({dbm:async()=>({db:{transaction:async(fn:(tx:unknown)=>unknown)=>fn({execute:state.execute})}}),Abort:class extends Error{constructor(public error:unknown){super('abort');}}}));
vi.mock('../../admin/core',()=>({auditMeta:()=>({}),writeAudit:state.audit,send:(r:{ok:boolean;data?:unknown;error?:{code:string}})=>Response.json(r.ok?{ok:true,data:r.data}:{error:r.error},{status:r.ok?200:r.error?.code==='validation'?422:404})}));
import { questionEditorialCatalogRoutes } from './routes';
const id='33000000-0000-4000-8000-000000000001';
const app=()=>new Hono<Env>().use('*',async(c,next)=>{c.set('userId',id);await next();}).route('/v1/editorial/questions',questionEditorialCatalogRoutes);
beforeEach(()=>{vi.clearAllMocks();process.env.QUESTIONS_CATALOG_ENABLED='1';process.env.SHARE_SECRET='synthetic-editorial-secret';state.audit.mockResolvedValue({id:1});});
describe('CCR139 editorial read routes',()=>{
 it.each(['reviewer','admin'])('allows %s metadata without claiming medical approval',async role=>{state.execute.mockResolvedValueOnce([{role}]).mockResolvedValueOnce([]);const r=await app().request('/v1/editorial/questions/catalog');expect(r.status).toBe(200);const b=await r.json();expect(questionAdminCatalogPageSchema.safeParse(b.data).success).toBe(true);expect(b.data).not.toHaveProperty('audit');expect(state.audit).toHaveBeenCalledTimes(1);expect(state.audit.mock.calls[0]![0]).toMatchObject({action:'question.catalog_view',after:{count:0,hasMore:false}});});
 it.each([{rows:[]},{rows:[{role:'student'}]}])('hides absent/inactive/unauthorized role',async({rows})=>{state.execute.mockResolvedValueOnce(rows);expect((await app().request('/v1/editorial/questions/catalog')).status).toBe(404);expect(state.execute).toHaveBeenCalledTimes(1);expect(state.audit).not.toHaveBeenCalled();});
 it('rejects duplicated query, invalid cursor and private history without successful audit',async()=>{state.execute.mockResolvedValueOnce([{role:'reviewer'}]);expect((await app().request('/v1/editorial/questions/catalog?status=withdrawn&status=published')).status).toBe(422);state.execute.mockResolvedValueOnce([{role:'reviewer'}]);expect((await app().request('/v1/editorial/questions/catalog?cursor=bad')).status).toBe(422);state.execute.mockResolvedValueOnce([{role:'reviewer'}]).mockResolvedValueOnce([]);expect((await app().request('/v1/editorial/questions/'+id+'/reviews')).status).toBe(404);expect(state.audit).not.toHaveBeenCalled();});
 it('keeps unrelated legacy routes outside new flag middleware',async()=>{process.env.QUESTIONS_CATALOG_ENABLED='0';const parent=app().get('/v1/editorial/questions/legacy',c=>c.text('legacy'));expect((await parent.request('/v1/editorial/questions/catalog')).status).toBe(404);expect((await parent.request('/v1/editorial/questions/legacy')).status).toBe(200);expect(state.execute).not.toHaveBeenCalled();});
});
