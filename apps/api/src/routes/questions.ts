import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema, questionOwnerOutboxQuerySchema, questionListQuerySchema, questionReportInputSchema, questionUserStateInputSchema } from '@remoa/contracts';
import type { Env } from '../app';
import { fail } from '../app';
import { asServer, guard, run } from '../db';
import { catalogQueryValues } from '../questions/editorial/catalog';
import { outboxPage } from '../questions/generation/outbox';
import { questionCatalog, questionExams, getQuestionInstitutions, validation } from '../questions/catalog/service';
export const parseQuestionInput=<S extends z.ZodTypeAny>(schema:S,input:unknown):z.infer<S>=>{const parsed=schema.safeParse(input);if(!parsed.success)throw validation('invalid_question_input');return parsed.data;};
export async function questionResponse(fn:()=>Promise<unknown>){const result=await guard(fn);return result.ok?Response.json({ok:true,data:result.data}):fail(result.error);}
export function questionsRoutes(){return new Hono<Env>()
  // D-1805: the caller's own generation outbox, metadata only (no recovery here). Server-only table read inside the user's transaction.
  .get('/generation/outbox',c=>questionResponse(async()=>{const userId=c.get('userId'),query=parseQuestionInput(questionOwnerOutboxQuerySchema,catalogQueryValues(c.req.url));const page=await run(userId,tx=>outboxPage(q=>asServer<Record<string,unknown>>(tx,q),query,{actor:{id:userId,role:'owner'},route:c.req.path,query},userId));if(!page.ok)throw validation(page.error.message);return page.data;}))
  .get('/',c=>questionResponse(()=>questionCatalog.list(c.get('userId'),parseQuestionInput(questionListQuerySchema,c.req.query()))))
  .get('/:id',c=>questionResponse(()=>questionCatalog.get(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')))))
  .get('/:id/user-state',c=>questionResponse(()=>questionCatalog.state(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')))))
  .put('/:id/user-state',c=>questionResponse(async()=>questionCatalog.setState(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')),parseQuestionInput(questionUserStateInputSchema,await c.req.json().catch(()=>null)))))
  .post('/:id/reports',c=>questionResponse(async()=>questionCatalog.report(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')),parseQuestionInput(questionReportInputSchema,await c.req.json().catch(()=>null)))));
}
export function examsRoutes(){return new Hono<Env>()
  .get('/',c=>questionResponse(()=>questionExams.list(c.get('userId'))))
  .get('/:id',c=>questionResponse(()=>questionExams.get(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')))));
}

export function questionInstitutionsRoutes(){return new Hono<Env>().get('/',c=>questionResponse(()=>getQuestionInstitutions(c.get('userId'))));}
