import { Hono } from 'hono';
import { idSchema, examTemplateInputSchema } from '@remoa/contracts';
import type { Env } from '../app';
import { parseQuestionInput, questionResponse } from './questions';
import { examTemplates } from '../questions/templates/service';
/** Mounted behind requireUser + catalog + bankStudent gates (app.ts). */
export function examTemplatesRoutes() {
  return new Hono<Env>()
    .get('/', (c) => questionResponse(() => examTemplates.list(c.get('userId'))))
    .post('/', (c) => questionResponse(async () => examTemplates.create(c.get('userId'), parseQuestionInput(examTemplateInputSchema, await c.req.json().catch(() => null)))))
    .delete('/:id', (c) => questionResponse(() => examTemplates.remove(c.get('userId'), parseQuestionInput(idSchema, c.req.param('id')))));
}
