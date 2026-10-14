import { Hono } from 'hono';
import { examBuilderFilterSchema, examGenerateInputSchema, examGenerateResultSchema, examPreviewInputSchema, examRevalidateInputSchema, examSwapInputSchema } from '@remoa/contracts';
import type { Env } from '../app';
import { parseQuestionInput, questionResponse } from './questions';
import { fail } from '../app';
import { generateQuestions } from '../challenge-ai/generate';
import { takeAiSlot } from './challenge-ai';
import { examBuilder } from '../questions/builder/service';
/** F34 FR-24..28: mounted behind requireUser + catalog + bankStudent. Read-only; no response carries an answer key (D-1822). */
/** D-1846: generate is injectable so route tests never reach a provider (rule 13). */
export function examBuilderRoutes(generate:typeof generateQuestions=generateQuestions){return new Hono<Env>()
  .post('/availability',c=>questionResponse(async()=>examBuilder.availability(c.get('userId'),parseQuestionInput(examBuilderFilterSchema,await c.req.json().catch(()=>null)))))
  .post('/preview',c=>questionResponse(async()=>examBuilder.preview(c.get('userId'),parseQuestionInput(examPreviewInputSchema,await c.req.json().catch(()=>null)))))
  .post('/swap',c=>questionResponse(async()=>examBuilder.swap(c.get('userId'),parseQuestionInput(examSwapInputSchema,await c.req.json().catch(()=>null)))))
  // D-1846: map as base. Reuses the map's unseen AI questions, then the model (ai_question_batches per batch, refunds as F32). Ids + counts only, never a stem or key.
  .post('/generate',async c=>{
    const userId=c.get('userId');
    const parsed=examGenerateInputSchema.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return fail({code:'validation',message:'invalid_question_input'});
    const slot=takeAiSlot(userId);
    if(!slot.ok){const res=fail(slot.error);res.headers.set('retry-after','60');return res;}
    const {boardId,count,difficulty}=parsed.data;
    const r=await generate({userId,boardId,scope:{kind:'board'},n:count,questionType:'objective',difficulty,requestId:c.get('requestId')});
    if(!r.ok)return fail(r.error);
    const d=r.data;
    return Response.json({ok:true,data:examGenerateResultSchema.parse({questionIds:d.questions.map(q=>q.id),requested:d.requested,reused:d.reused,generated:d.generated,shortfall:d.shortfall,stoppedBy:d.stoppedBy})});
  })
  .post('/revalidate',c=>questionResponse(async()=>examBuilder.revalidate(c.get('userId'),parseQuestionInput(examRevalidateInputSchema,await c.req.json().catch(()=>null)))));
}
