import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "remoa",
  eventKey: process.env.INNGEST_EVENT_KEY,
  isDev: process.env.NODE_ENV !== "production",
});

/** The job runs through Inngest only when a key or the dev server flag is set. Otherwise the API runs the same function inline. */
export function inngestConfigured(): boolean {
  return Boolean(
    process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV === "1",
  );
}

export async function dispatchBoardJob(jobId: string): Promise<boolean> {
  if (!inngestConfigured()) return false;
  await inngest.send({ name: "ai/board.generate", data: { jobId } });
  return true;
}

/** F33: the committed DB outbox is authoritative; local fallback uses the same durable repository. */
export async function dispatchQuestionImport(
  importId: string,
  waitForLocal = false,
): Promise<boolean> {
  const { questionFeatures } = await import("../questions/runtime/config");
  if (!questionFeatures().import) return false;
  const { db, questionOutbox } = await import("../db").then((m) => m.dbm());
  const { and, eq, isNull } = await import("drizzle-orm");
  const pending = await db
    .select()
    .from(questionOutbox)
    .where(
      and(
        eq(questionOutbox.importId, importId),
        isNull(questionOutbox.deliveredAt),
      ),
    );
  if (inngestConfigured()) {
    await inngest.send({
      id: pending[0]?.eventKey ?? `questions/import:${importId}:${Date.now()}`,
      name: "questions/import.requested",
      data: { importId },
    });
  } else {
    // Long-lived local Node process; a crash leaves the DB lease/outbox recoverable by manual retry or the reconciler.
    const { runStoredQuestionImport } =
      await import("../questions/imports/store");
    if (waitForLocal) await runStoredQuestionImport(importId);
    else void runStoredQuestionImport(importId).catch(() => undefined);
  }
  if (pending.length)
    await db
      .update(questionOutbox)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          eq(questionOutbox.importId, importId),
          isNull(questionOutbox.deliveredAt),
        ),
      );
  return inngestConfigured();
}
