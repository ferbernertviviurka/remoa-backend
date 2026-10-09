import { createLogger } from "@remoa/log";
import { reconcileQuestionImports } from "../../inngest/question-import";
import { reconcileQuestionGenerations } from "../generation/reconcile";
/** Each repository claims rows with its own fenced DB lease; concurrent cron/startup callers are safe. No provider calls. */
export async function reconcileQuestionRuntime() {
  const started = Date.now();
  const log = createLogger({ requestId: "question-recovery" });
  const results = await Promise.allSettled([
    reconcileQuestionGenerations(),
    reconcileQuestionImports(),
  ]);
  const names = ["generation", "imports"] as const;
  const out: Record<string, unknown> = {};
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") out[names[index]!] = result.value;
    else {
      out[names[index]!] = { failed: true };
      log.error("question recovery failed", {
        pipeline: names[index],
        code:
          result.reason instanceof Error
            ? result.reason.name
            : "recovery_failed",
      });
    }
  }
  log.info("question recovery complete", {
    durationMs: Date.now() - started,
    ...out,
  });
  if (results.some((r) => r.status === "rejected"))
    throw Error("question_recovery_failed");
  return out;
}
