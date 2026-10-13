/** F34 FR-4/FR-31 (D-1829): saved exam templates. Owner only (RLS read; writes by the server role), count capped by PlanDefinition.exam_templates. */
import { sql } from 'drizzle-orm';
import { examTemplateListSchema, examTemplateSchema, planDefinition, type ExamTemplateInput } from '@remoa/contracts';
import { Abort, asServer, pgCode, run } from '../../db';
import { planOf } from '../../billing/plan';
import { conflict, missing, type Row } from '../catalog/service';

const columns = sql`id,name,params,created_at "createdAt",updated_at "updatedAt"`;
const dto = (r: Row) => examTemplateSchema.parse({ id: r.id, name: r.name, params: r.params, createdAt: r.createdAt, updatedAt: r.updatedAt });
const limitOf = async (tx: Parameters<typeof planOf>[2], userId: string) => planDefinition((await planOf(userId, new Date(), tx)).plan).exam_templates;

export const examTemplates = {
  async list(userId: string) {
    return run(userId, async (tx) => {
      const [rows, limit] = await Promise.all([asServer<Row>(tx, sql`SELECT ${columns} FROM exam_templates WHERE user_id=${userId} ORDER BY created_at DESC,id DESC LIMIT 100`), limitOf(tx, userId)]);
      return examTemplateListSchema.parse({ items: rows.map(dto), limit });
    });
  },
  async create(userId: string, input: ExamTemplateInput) {
    const body = examTemplateSchema.pick({ name: true, params: true }).parse(input);
    try {
      return await run(userId, async (tx) => {
        // Owner-scoped lock: two parallel creates cannot both pass the count check.
        await asServer(tx, sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':exam-templates'},34))`);
        const limit = await limitOf(tx, userId);
        const [n] = await asServer<Row>(tx, sql`SELECT count(*)::int n FROM exam_templates WHERE user_id=${userId}`);
        if (limit !== null && Number(n?.n) >= limit) throw conflict('limit_reached');
        const [row] = await asServer<Row>(tx, sql`INSERT INTO exam_templates(user_id,name,params) VALUES(${userId},${body.name},${JSON.stringify(body.params)}::jsonb) RETURNING ${columns}`);
        return dto(row!);
      });
    } catch (e) {
      if (!(e instanceof Abort) && pgCode(e) === '23505') throw conflict('template_name_taken');
      throw e;
    }
  },
  async remove(userId: string, id: string) {
    return run(userId, async (tx) => {
      const rows = await asServer<Row>(tx, sql`DELETE FROM exam_templates WHERE id=${id} AND user_id=${userId} RETURNING id`);
      if (!rows.length) throw missing();
      return { deleted: true as const };
    });
  },
};
