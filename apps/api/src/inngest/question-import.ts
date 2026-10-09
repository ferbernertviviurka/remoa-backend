import { sql } from "drizzle-orm";
import { inngest, dispatchQuestionImport } from "./client";
import { dbm } from "../db";
import { runStoredQuestionImport } from "../questions/imports/store";
export const questionImport = inngest.createFunction(
  {
    id: "question-import",
    retries: 0,
    concurrency: { limit: 5 },
    triggers: [{ event: "questions/import.requested" }],
  },
  async ({ event, step }) => {
    const id =
      typeof event.data.importId === "string" ? event.data.importId : "";
    return step.run("extract-and-stage", () => runStoredQuestionImport(id));
  },
);
/** DB outbox and expiring worker leases survive HTTP timeouts/process restarts. Failed jobs wait for an audited manual retry. */
export async function reconcileQuestionImports() {
  const { questionFeatures } = await import("../questions/runtime/config");
  if (!questionFeatures().import) return { dispatched: 0, disabled: true };
  const { db } = await dbm();
  const rows = await db.execute<{ id: string }>(
    sql`select id from question_imports where status in ('queued','validating','extracting','ocr','segmenting','matching') and (lease_until is null or lease_until<now()) order by created_at limit 5`,
  );
  for (const row of rows) await dispatchQuestionImport(row.id, true);
  return { dispatched: rows.length };
}
export const questionImportReconcile = inngest.createFunction(
  {
    id: "question-import-reconcile",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) =>
    step.run("recover-questions", async () => {
      const { reconcileQuestionRuntime } =
        await import("../questions/runtime/recovery");
      return reconcileQuestionRuntime();
    }),
);
