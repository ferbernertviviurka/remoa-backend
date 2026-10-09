import {Hono} from 'hono';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {Env} from '../../app';
import type {ZodType} from 'zod';
const state=vi.hoisted(()=>({history:vi.fn(),get:vi.fn()}));
vi.mock('./history',()=>({sessionHistory:state.history}));
vi.mock('./service',()=>({questionSessionService:{get:state.get}}));
vi.mock('../../routes/questions',()=>{return {parseQuestionInput:(schema:ZodType,input:unknown)=>{const r=schema.safeParse(input);if(!r.success)throw Error('validation');return r.data;},questionResponse:async(fn:()=>unknown)=>{try{return Response.json({ok:true,data:await fn()});}catch{return Response.json({ok:false,error:{code:'validation'}},{status:422});}}};});
import {questionSessionsRoutes} from '../../routes/question-sessions';
const owner='44000000-0000-4000-8000-000000000001';const app=()=>new Hono<Env>().use('*',async(c,next)=>{c.set('userId',owner);await next();}).route('/v1/question-sessions',questionSessionsRoutes());
beforeEach(()=>{vi.clearAllMocks();process.env.QUESTIONS_SESSIONS_ENABLED='1';state.history.mockResolvedValue({items:[],nextCursor:null});});
describe('CCR139 session static history route',()=>{
 it('mounts before dynamic ID and infers authenticated owner',async()=>{expect((await app().request('/v1/question-sessions/history?status=active')).status).toBe(200);expect(state.history).toHaveBeenCalledWith(owner,{status:'active',limit:20},'/v1/question-sessions/history');expect(state.get).not.toHaveBeenCalled();});
 it.each(['?status=active&status=finished','?ownerId='+owner,'?limit=21','?status='])('rejects invalid or duplicate inputs %s',async suffix=>{expect((await app().request('/v1/question-sessions/history'+suffix)).status).toBe(422);expect(state.history).not.toHaveBeenCalled();});
 it('hides flag off before history access',async()=>{process.env.QUESTIONS_SESSIONS_ENABLED='0';expect((await app().request('/v1/question-sessions/history')).status).toBe(404);expect(state.history).not.toHaveBeenCalled();});
});
