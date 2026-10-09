import { createMiddleware } from "hono/factory";
import {
  err,
  questionSessionConfigSchema,
  questionFeatureFlagsSchema,
  ok,
} from "@remoa/contracts";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { send } from "../../admin/core";
import type { Env } from "../../app";
import { dbm } from "../../db";
import {
  questionFeatures,
  questionAdmissionLimits,
  type AdmissionKind,
  type QuestionFeature,
} from "./config";
const windows = {
  upload: 60_000,
  import: 60_000,
  session: 60_000,
  report: 3_600_000,
} as const;
/** Like F19 Q-008: an abuse guard per API instance. Durable import concurrency is separate in PostgreSQL. */
export function createQuestionAdmission() {
  const hits = new Map<string, number[]>();
  return {
    take(kind: AdmissionKind, owner: string, target = "", now = Date.now()) {
      const limit = questionAdmissionLimits()[kind],
        window = windows[kind],
        key = JSON.stringify([kind, owner, target]);
      if (hits.size > 10_000)
        for (const [k, times] of hits)
          if (times.every((t) => now - t >= windows.report)) hits.delete(k);
      const recent = (hits.get(key) ?? []).filter((t) => now - t < window);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      hits.set(key, [...recent, now]);
      return true;
    },
  };
}
const admission = createQuestionAdmission();
export const questionFeatureGate = (feature: QuestionFeature) =>
  createMiddleware<Env>(async (_c, next) =>
    questionFeatures()[feature]
      ? next()
      : send(err("not_found", "route not found")),
  );
export const questionFeatureResponse = () =>
  send(ok(questionFeatureFlagsSchema.parse(questionFeatures())));
export const questionImportAdmission = createMiddleware<Env>(
  async (c, next) => {
    const path = c.req.path;
    if (c.req.method !== "POST") return next();
    const kind = path.endsWith("/documents")
      ? "upload"
      : path.endsWith("/imports") || /\/imports\/[^/]+\/retry$/.test(path)
        ? "import"
        : null;
    if (!kind) return next();
    if (!questionFeatures().import)
      return send(err("not_found", "route not found"));
    if (!admission.take(kind, c.get("userId")))
      return send(err("rate_limited", "question_" + kind + "_rate_limited"));
    await next();
  },
);
export const questionUserAdmission = createMiddleware<Env>(async (c, next) => {
  if (c.req.method !== "POST") return next();
  if (/\/questions\/([^/]+)\/reports$/.test(c.req.path)) {
    const target = c.req.path.split("/").at(-2)!;
    if (!admission.take("report", c.get("userId"), target))
      return send(err("rate_limited", "question_report_rate_limited"));
  }
  if (c.req.path.replace(/\/$/, "") === "/v1/question-sessions") {
    if (!admission.take("session", c.get("userId")))
      return send(err("rate_limited", "question_session_rate_limited"));
    if (!questionFeatures().catalog) {
      const body = await c.req.json().catch(() => null),
        parsed = questionSessionConfigSchema.safeParse(body);
      if (parsed.success) {
        const config = parsed.data;
        if (
          config.examId ||
          (config.filters && config.filters.scope !== "mine")
        )
          return send(err("not_found", "route not found"));
        if (config.questionIds) {
          const { db, questionBank: q } = await dbm();
          const [publicSelection] = await db
            .select({ id: q.id })
            .from(q)
            .where(
              and(
                inArray(q.id, config.questionIds),
                eq(q.visibility, "public"),
                isNull(q.userId),
              ),
            )
            .limit(1);
          if (publicSelection) return send(err("not_found", "route not found"));
        }
      }
    }
  }
  await next();
});
