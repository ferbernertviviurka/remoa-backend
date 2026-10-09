import { sessionHistory } from "../questions/sessions/history";
import { catalogQueryValues } from "../questions/editorial/catalog";
import { questionFeatureGate } from "../questions/runtime/admission";
import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema, questionSessionConfigSchema, questionAnswerInputSchema, questionSessionsPageQuerySchema } from '@remoa/contracts';
import type { Env } from '../app';
import { parseQuestionInput, questionResponse } from './questions';
import { questionSessionService } from '../questions/sessions/service';
import { recalculateSession } from '../questions/sessions/recalculation';
const empty=z.object({}).strict();
export function questionSessionsRoutes(){return new Hono<Env>()
  .get('/',c=>questionResponse(()=>questionSessionService.list(c.get('userId'))))
  .post('/',c=>questionResponse(async()=>questionSessionService.create(c.get('userId'),parseQuestionInput(questionSessionConfigSchema,await c.req.json().catch(()=>null)),parseQuestionInput(idSchema,c.req.header('idempotency-key')))))
  .get('/history',questionFeatureGate('sessions'),c=>questionResponse(()=>sessionHistory(c.get('userId'),parseQuestionInput(questionSessionsPageQuerySchema,catalogQueryValues(c.req.url)),c.req.path)))
  .get('/:id',c=>questionResponse(()=>questionSessionService.get(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')))))
  .put('/:id/items/:itemId/answer',c=>questionResponse(async()=>questionSessionService.answer(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')),parseQuestionInput(idSchema,c.req.param('itemId')),parseQuestionInput(questionAnswerInputSchema,await c.req.json().catch(()=>null)))))
  .get('/:id/items/:itemId/reference',c=>questionResponse(()=>questionSessionService.reference(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')),parseQuestionInput(idSchema,c.req.param('itemId')))))
  .post('/:id/finish',c=>questionResponse(async()=>{parseQuestionInput(empty,await c.req.json().catch(()=>null));return questionSessionService.finish(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')));}))
  .get('/:id/recalculation',c=>questionResponse(()=>recalculateSession(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')))))
  .get('/:id/report',c=>questionResponse(()=>questionSessionService.report(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')))))
  .post('/:id/review',c=>questionResponse(async()=>{parseQuestionInput(empty,await c.req.json().catch(()=>null));return questionSessionService.review(c.get('userId'),parseQuestionInput(idSchema,c.req.param('id')));}));
}
