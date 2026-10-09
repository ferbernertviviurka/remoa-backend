import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  err,
  ok,
  parseWith,
  questionEditorialReviewInputSchema,
  questionContextBindingSchema,
} from "@remoa/contracts";
import { dbm } from "../../db";
import { invalidate } from "../../cache";
import { normalizeCrm } from "../../editorial/editorial";
import { writeAudit } from "../../admin/core/audit";
import { presignGet } from "../../storage/storage";
import { contentHash, isContextManaged } from "../imports/domain";
import { lockAssociatedQuestionGraphs } from "../../admin/questions/recovery";
import type { Tx } from "@remoa/db";
import type { Context } from "hono";
import type { Env } from "../../app";
import { auditMeta } from "../../admin/core/audit";
async function signer(userId: string, readOnly = false) {
  const { db, profiles: p } = await dbm();
  const [row] = await db
    .select({
      role: p.role,
      name: p.name,
      crm: p.crm,
      deletedAt: p.deletedAt,
      suspendedAt: p.suspendedAt,
    })
    .from(p)
    .where(eq(p.userId, userId));
  if (!row || row.role === "student" || row.deletedAt || row.suspendedAt)
    return err("not_found", "route not found");
  if (readOnly && row.role === "admin")
    return ok({ name: row.name ?? "Admin", crm: "" });
  if (row.role !== "reviewer") return err("forbidden", "reviewer_only");
  const crm = normalizeCrm(row.crm);
  if (!crm || !row.name?.trim())
    return err("validation", "reviewer_crm_required");
  return ok({ name: row.name, crm });
}
export async function reviewDto(
  row: typeof import("@remoa/db").questionBank.$inferSelect,
) {
  let ownStem: string | null = null;
  let contextManaged = false;
  const contextBindings: import('@remoa/contracts').QuestionReviewDetail['contextBindings'] = [];
  if (row.visibility === 'public' && row.userId === null) {
    const { db, questionImportCandidates: staging } = await dbm();
    const candidates = await db.select({payload:staging.payload}).from(staging).where(eq(staging.questionId,row.id));
    for (const candidate of candidates) {
      if (isContextManaged(candidate.payload)) contextManaged = true;
      if (contextManaged && typeof candidate.payload.ownStem === 'string')ownStem = candidate.payload.ownStem;
      if (!Array.isArray(candidate.payload.contextBindings)) continue;
      for (const binding of candidate.payload.contextBindings) {
        const parsed = questionContextBindingSchema.safeParse(binding);
        if (parsed.success && !contextBindings.some(b=>b.contextId===parsed.data.contextId))contextBindings.push(parsed.data);
      }
      if (contextBindings.length && typeof candidate.payload.ownStem === 'string')ownStem = candidate.payload.ownStem;
    }
  }
  const assets = (row.assets ?? []) as {
    id: string;
    objectKey?: string;
    alt: string;
    provenance: unknown;
  }[];
  return {
    id: row.id,
    contextManaged,
    ownStem,
    contextBindings,
    canonicalId: row.canonicalId ?? row.id,
    version: row.version,
    type: row.type,
    difficulty: row.difficulty,
    stem: row.stem,
    alternatives: row.alternatives,
    correctKey: row.correctKey,
    explanation: row.explanation,
    areaId: row.enamedAreaId,
    topicId: row.enamedTopicId,
    origin: row.origin,
    sourceId: row.sourceId,
    catalogStatus: row.catalogStatus,
    rightsStatus: row.rightsStatus,
    availability: row.availability,
    integrityConfirmed: row.integrityConfirmed,
    keyFinal: row.keyFinal,
    enamedConfirmed: row.enamedConfirmed,
    contentHash: row.contentHash,
    reviewedHash: row.reviewedHash,
    reviewerName: row.reviewerName,
    reviewerCrm: row.reviewerCrm,
    referenceDate: row.referenceDate,
    assets: await Promise.all(
      assets.map(async (asset) => ({
        ...asset,
        url: asset.objectKey ? await presignGet(asset.objectKey) : null,
      })),
    ),
  };
}
export async function questionReviewQueue(c: Context<Env>) {
  const identity = await signer(c.get("userId"), true);
  if (!identity.ok) return identity;
  const { db, questionBank: q } = await dbm();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(q)
      .where(
        and(
          eq(q.visibility, "public"),
          isNull(q.userId),
          eq(q.catalogStatus, "in_review"),
          sql`not exists(select 1 from question_bank n where n.supersedes_id=${q.id})`,
        ),
      )
      .orderBy(desc(q.createdAt))
      .limit(50);
    await writeAudit(
      {
        ...auditMeta(c),
        actorType: "user",
        actorId: c.get("userId"),
        action: "question.import_view",
        targetType: "route",
        targetId: c.req.path,
        reason: "Consultar fila de revisão médica de questões",
        result: "success",
        after: { count: rows.length },
      },
      tx,
    );
    return ok({ items: await Promise.all(rows.map(reviewDto)) });
  });
}
export async function questionReviewDetail(c: Context<Env>, id: string) {
  const identity = await signer(c.get("userId"), true);
  if (!identity.ok) return identity;
  const {
    db,
    questionBank: q,
    questionEditorialReviews: r,
    questionSourcesCatalog: s,
  } = await dbm();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(q)
      .where(and(eq(q.id, id), eq(q.visibility, "public"), isNull(q.userId)));
    if (!row) return err("not_found", "question not found");
    const [last] = await tx
      .select({
        decision: r.decision,
        contentHash: r.contentHash,
        reviewerName: r.reviewerName,
        reviewerCrm: r.reviewerCrm,
        referenceDate: r.referenceDate,
        reviewedAt: r.reviewedAt,
      })
      .from(r)
      .where(eq(r.questionId, id))
      .orderBy(desc(r.reviewedAt), desc(r.id))
      .limit(1);
    await writeAudit(
      {
        ...auditMeta(c),
        actorType: "user",
        actorId: c.get("userId"),
        action: "question.import_view",
        targetType: "question",
        targetId: id,
        reason: "Abrir questão para revisão médica",
        result: "success",
      },
      tx,
    );
    const [source] = row.sourceId
      ? await tx.select().from(s).where(eq(s.id, row.sourceId))
      : [];
    return ok({
      question: await reviewDto(row),
      latestReview: last ?? null,
      source: source ?? null,
    });
  });
}
export async function recordMedicalReview(
  c: Context<Env>,
  id: string,
  json: unknown,
) {
  const identity = await signer(c.get("userId"));
  if (!identity.ok) return identity;
  const input = parseWith(questionEditorialReviewInputSchema, json);
  if (!input.ok) return input;
  const date = new Date(input.data.referenceDate + "T00:00:00.000Z");
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== input.data.referenceDate
  )
    return err("validation", "invalid_reference_date");
  const {
    db,
    questionBank: q,
    questionEditorialReviews: r,
    examQuestionOccurrences: o,
    examPapers: p,
  } = await dbm();
  const result = await db.transaction(async (tx: Tx) => {
    const locked = await lockAssociatedQuestionGraphs(tx, id);
    if (!locked.ok) return locked;
    const [row] = await tx
      .select()
      .from(q)
      .where(and(eq(q.id, id), eq(q.visibility, "public"), isNull(q.userId)))
      .for("update");
    if (!row) return err("not_found", "question not found");
    const hash = contentHash({
      stem: row.stem,
      alternatives: row.alternatives,
      correctKey: row.correctKey,
      explanation: row.explanation,
      areaId: row.enamedAreaId,
      topicId: row.enamedTopicId,
      annulled: row.availability === "annulled",
      assets: row.assets,
    });
    if (hash !== row.contentHash || hash !== input.data.contentHash)
      return err("conflict", "content_hash_changed");
    if (
      input.data.decision === "approved" &&
      (!row.integrityConfirmed ||
        !row.keyFinal ||
        !row.explanation?.trim() ||
        !row.enamedConfirmed ||
        !row.enamedAreaId ||
        !row.enamedTopicId)
    )
      return err("validation", "medical_review_incomplete");
    await tx.insert(r).values({
      questionId: id,
      reviewerId: c.get("userId"),
      reviewerName: identity.data.name,
      reviewerCrm: identity.data.crm,
      contentHash: hash,
      decision: input.data.decision,
      reason: input.data.reason,
      referenceDate: input.data.referenceDate,
    });
    const approved = input.data.decision === "approved";
    // The published version's medical identity is historical content. New decisions append
    // records; a negative decision only withdraws distribution, and approval never republishes it.
    if (row.publishedAt || row.catalogStatus === "published") {
      if (!approved) await tx.update(q).set({ catalogStatus: "withdrawn" }).where(eq(q.id,id));
      else if(row.catalogStatus === "withdrawn" && row.reviewedHash === hash && row.reviewerName?.trim() === identity.data.name.trim() && normalizeCrm(row.reviewerCrm) === identity.data.crm && row.referenceDate === input.data.referenceDate) {
        // Only the identical historical signature may prepare an explicit admin republication.
        await tx.update(q).set({catalogStatus:"approved"}).where(eq(q.id,id));
      }
    } else {
    await tx
      .update(q)
      .set({
        status: approved ? "approved" : "draft",
        catalogStatus: approved
          ? "approved"
          : input.data.decision === "rejected"
            ? "rejected"
            : "in_review",
        reviewedHash: approved ? hash : null,
        reviewerName: approved ? identity.data.name : null,
        reviewerCrm: approved ? identity.data.crm : null,
        referenceDate: approved ? input.data.referenceDate : null,
      })
      .where(eq(q.id, id));
    }
    if (!approved) {
      const papers = await tx
        .select({ id: o.paperId })
        .from(o)
        .where(eq(o.questionId, id));
      for (const paper of papers)
        await tx
          .update(p)
          .set({ status: "withdrawn" })
          .where(eq(p.id, paper.id));
    }
    const audit = await writeAudit(
      {
        ...auditMeta(c),
        actorType: "user",
        actorId: c.get("userId"),
        action: "question.review",
        targetType: "question",
        targetId: id,
        reason: input.data.reason,
        result: "success",
        before: { catalogStatus: row.catalogStatus, contentHash: hash },
        after: { decision: input.data.decision, contentHash: hash },
      },
      tx,
    );
    return ok({ id, decision: input.data.decision, contentHash: hash, audit });
  });
  if(result.ok) await invalidate('admin.action',{});
  return result;
}
