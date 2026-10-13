import { Hono } from 'hono';
import { examBuilderFilterSchema, examPreviewInputSchema, examRevalidateInputSchema, examSwapInputSchema } from '@remoa/contracts';
import type { Env } from '../app';
import { parseQuestionInput, questionResponse } from './questions';
import { examBuilder } from '../questions/builder/service';
/** F34 FR-24..28: mounted behind requireUser + catalog + bankStudent. Read-only; no response carries an answer key (D-1822). */
export function examBuilderRoutes(){return new Hono<Env>()
  .post('/availability',c=>questionResponse(async()=>examBuilder.availability(c.get('userId'),parseQuestionInput(examBuilderFilterSchema,await c.req.json().catch(()=>null)))))
  .post('/preview',c=>questionResponse(async()=>examBuilder.preview(c.get('userId'),parseQuestionInput(examPreviewInputSchema,await c.req.json().catch(()=>null)))))
  .post('/swap',c=>questionResponse(async()=>examBuilder.swap(c.get('userId'),parseQuestionInput(examSwapInputSchema,await c.req.json().catch(()=>null)))))
  .post('/revalidate',c=>questionResponse(async()=>examBuilder.revalidate(c.get('userId'),parseQuestionInput(examRevalidateInputSchema,await c.req.json().catch(()=>null)))));
}
