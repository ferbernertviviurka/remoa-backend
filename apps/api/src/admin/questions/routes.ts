import { catalogCapacitySQL, type CatalogCapacity } from './capacity';
import { questionTeamPublicationRoutes } from './team-publication/routes';
import { questionImportsPageRoutes } from "./imports-page";
import { questionAdminCatalogRoutes } from './catalog';
import { questionAdminOperationsRoutes } from './operations';
import { parserWarningsResponse } from './parser-warnings';
import {
  questionFeatureGate,
  questionImportAdmission,
} from "../../questions/runtime/admission";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  err,
  ok,
  parseWith,
  questionSourceInputSchema,
  questionImportInputSchema,
  importCandidateReviewInputSchema,
  questionCandidateAcceptInputSchema,
  questionPublishInputSchema,
  questionDraftUpdateInputSchema,
  questionCandidatePageImageInputSchema,
  questionCandidateCreateInputSchema,
  questionCandidateNumberInputSchema,
  questionImportContextResolveInputSchema,
  reasonSchema,
  questionOrigins,
  questionAcervoCoverageSchema,
} from "@remoa/contracts";
import { dbm } from "../../db";
import { withAdmin, reasonOf, send, type AdminEnv } from "../core";
import {
  createImport,
  documentPreview,
  idValid,
  importDetail,
  progress,
  publishQuestion,
  updateCandidate,
  uploadDocument,
  prepareDocument,
  cropPreview,
  rectifyQuestion,
  updateQuestionDraft,
  candidatePreviewMetadata,
  questionRegionPreview,
  candidatePageImageMetadata,
  appendCandidatePageImage,
  withCandidatePageImage,
  cleanupCandidatePageImage,
} from "./service";
import { preparePageImage } from "../../questions/imports/manual-page-image";
import { documentPagePreviewResponse } from './page-preview';
import { deleteObject } from "../../storage/storage";
import { dispatchQuestionImport } from "../../inngest/client";
import { acceptCandidates } from "./accept-batch";
import { createRecoveredCandidate, recoverCandidateNumber, resolveImportContext } from "./recovery";
const readJson = async (c: { req: { json: () => Promise<unknown> } }) =>
  c.req.json().catch(() => null);
import { questionAdminReportRoutes } from "../../questions/reports/admin";
export const questionAdminRoutes = new Hono<AdminEnv>()
  .route("/team-publication", questionTeamPublicationRoutes)
  .route("/", questionAdminOperationsRoutes) // D-1804/D-1805
  .route("/", questionAdminCatalogRoutes)
  .route("/", questionImportsPageRoutes)
  .route("/reports", questionAdminReportRoutes)

  .use("*", questionImportAdmission)
  .get("/imports/:id/parser-warnings", parserWarningsResponse)
  .get("/sources", async (c) =>
    send(
      await withAdmin(
        c,
        "question.import_view",
        {
          reason: "Consultar fontes do banco de questões",
          target: { type: "route", id: c.req.path },
        },
        async (tx, audit) => {
          const { questionSourcesCatalog: s } = await dbm();
          const items = await tx
            .select()
            .from(s)
            .orderBy(desc(s.createdAt))
            .limit(100);
          audit.after({ count: items.length });
          return ok({ items });
        },
      ),
    ),
  )
  .post("/sources", async (c) => {
    const json = await readJson(c);
    return send(
      await withAdmin(
        c,
        "question.source_update",
        {
          reason: reasonOf(json),
          target: { type: "question_source", id: "new" },
        },
        async (tx, audit) => {
          const input = parseWith(questionSourceInputSchema, json);
          if (!input.ok) return input;
          const { questionSourcesCatalog: s } = await dbm();
          const fields = { ...input.data };
          delete (fields as Partial<typeof fields>).reason;
          const [source] = await tx.insert(s).values(fields).returning();
          audit.after({ id: source!.id, rightsStatus: source!.rightsStatus });
          return ok({ source: source! });
        },
      ),
    );
  })
  .patch("/sources/:id", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "source not found"));
    const json = await readJson(c);
    return send(
      await withAdmin(
        c,
        "question.source_update",
        { reason: reasonOf(json), target: { type: "question_source", id } },
        async (tx, audit) => {
          const input = parseWith(questionSourceInputSchema, json);
          if (!input.ok) return input;
          const { questionSourcesCatalog: s, questionBank: q } = await dbm();
          const [old] = await tx
            .select()
            .from(s)
            .where(eq(s.id, id))
            .for("no key update");
          if (!old) return err("not_found", "source not found");
          // Team approvals use the fixed batch operation; revocation remains available without rewriting signed questions.
          const [signedTeamSource] = await tx.execute(sql`SELECT 1 FROM question_team_items WHERE source_id=${id}::uuid LIMIT 1`);
          if(signedTeamSource&&!['revoked','restricted'].includes(input.data.rightsStatus))return err("conflict","team_source_requires_batch_approval");
          const fields = { ...input.data };
          delete (fields as Partial<typeof fields>).reason;
          const [source] = await tx
            .update(s)
            .set(fields)
            .where(eq(s.id, id))
            .returning();
          if(signedTeamSource){
            audit.before({source:old});audit.after({source:source!,teamSource:true,questionSignaturesPreserved:true});
            return ok({source:source!});
          }
          await tx
            .update(q)
            .set(
              fields.rightsStatus === "authorized"
                ? { rightsStatus: "authorized" }
                : {
                    rightsStatus: fields.rightsStatus,
                    catalogStatus: "withdrawn",
                  },
            )
            .where(eq(q.sourceId, id));
          audit.before({ rightsStatus: old.rightsStatus });
          audit.after({ rightsStatus: source!.rightsStatus });
          return ok({ source: source! });
        },
      ),
    );
  })
  .post(
    "/documents",
    bodyLimit({
      maxSize: 105906176,
      onError: () =>
        Response.json(
          { error: { code: "validation", message: "pdf_too_large" } },
          { status: 413 },
        ),
    }),
    async (c) => {
      const form = await c.req.parseBody(),
        reason = String(form.reason ?? "");
      const opts = {
        reason,
        target: { type: "question_import" as const, id: "document" },
      };
      // withAdmin still owns denial audit; preparation only begins after its same reason gate pass.
      if (!reasonSchema.safeParse(reason).success)
        return send(
          await withAdmin(c, "question.import", opts, async () => ok({})),
        );
      const file = form.file;
      if (
        !(file instanceof File) ||
        typeof form.sourceId !== "string" ||
        !idValid(form.sourceId) ||
        !["exam", "answer_key"].includes(String(form.kind))
      )
        return send(
          await withAdmin(c, "question.import", opts, async () =>
            err("validation", "invalid_upload_fields"),
          ),
        );
      const prepared = await prepareDocument(
        c.get("admin").id,
        form.sourceId,
        String(form.kind) as "exam" | "answer_key",
        new Uint8Array(await file.arrayBuffer()),
      );
      if (!prepared.ok)
        return send(
          await withAdmin(c, "question.import", opts, async () => prepared),
        );
      let committed = false;
      try {
        const result = await withAdmin(
          c,
          "question.import",
          opts,
          async (tx, audit) => {
            const r = await uploadDocument(tx, prepared.data);
            if (r.ok) audit.after(r.data.document);
            return r;
          },
        );
        committed = result.ok && result.data.document.id === prepared.data.id;
        return send(result);
      } finally {
        if (!committed)
          await deleteObject(prepared.data.objectKey).catch((e) =>
            c.get("log").warn("question upload orphan cleanup pending", {
              objectKey: prepared.data.objectKey,
              code: e instanceof Error ? e.name : "cleanup_failed",
            }),
          );
      }
    },
  )
  .get("/documents/:id/preview", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "document not found"));
    return send(
      await withAdmin(
        c,
        "question.import_view",
        {
          reason: "Abrir PDF privado para conferência editorial",
          target: { type: "question_import", id },
        },
        async (tx, audit) => {
          const r = await documentPreview(tx, id);
          audit.after({ id });
          return r;
        },
      ),
    );
  })
  .get('/imports/:id/documents/:documentId/pages/:page/preview', documentPagePreviewResponse)
  .get("/imports", async (c) =>
    send(
      await withAdmin(
        c,
        "question.import_view",
        {
          reason: "Consultar importações de questões",
          target: { type: "route", id: c.req.path },
        },
        async (tx, audit) => {
          const { questionImports: i } = await dbm();
          const ids = await tx
            .select({ id: i.id })
            .from(i)
            .orderBy(desc(i.createdAt))
            .limit(50);
          const items = await Promise.all(ids.map((r) => progress(r.id, tx)));
          audit.after({ count: items.length });
          return ok({ items: items.filter(Boolean) });
        },
      ),
    ),
  )
  .post("/imports", async (c) => {
    const json = await readJson(c);
    const result = await withAdmin(
      c,
      "question.import",
      {
        reason: reasonOf(json),
        target: { type: "question_import", id: "new" },
      },
      async (tx, audit) => {
        const input = parseWith(questionImportInputSchema, json);
        if (!input.ok) return input;
        const r = await createImport(
          tx,
          c.get("admin").id,
          input.data,
          c.req.header("Idempotency-Key") ?? "",
        );
        if (r.ok)
          audit.after({ id: r.data.import.id, paperId: r.data.paperId });
        return r;
      },
    );
    if (result.ok)
      await dispatchQuestionImport(result.data.import.id).catch((e) =>
        c.get("log").warn("question import dispatch pending", {
          code: e instanceof Error ? e.name : "dispatch_failed",
        }),
      );
    return send(result);
  })
  .get("/imports/:id", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "import not found"));
    return send(
      await withAdmin(
        c,
        "question.import_view",
        {
          reason: "Conferir importação e candidatos de questões",
          target: { type: "question_import", id },
        },
        async (tx, audit) => {
          const detail = await importDetail(tx, id);
          if (!detail) return err("not_found", "import not found");
          audit.after({ id, candidates: detail.candidates.length });
          return ok(detail);
        },
      ),
    );
  })
  .post("/imports/:id/candidates", questionFeatureGate("import"), async c => {
    const id=c.req.param('id');if(!idValid(id))return send(err('not_found','import not found'));
    const json=await readJson(c);
    return send(await withAdmin(c,'question.candidate_create',{reason:reasonOf(json),target:{type:'question_import',id}},async(tx,audit)=>{
      const input=parseWith(questionCandidateCreateInputSchema,json);if(!input.ok)return input;
      const result=await createRecoveredCandidate(tx,id,input.data);
      if(result.ok)audit.after({candidateId:result.data.candidate.id,importRevision:result.data.importRevision});
      return result;
    }));
  })
  .post("/imports/:id/candidates/:candidateId/number", questionFeatureGate("import"), async c => {
    const id=c.req.param('id'), candidateId=c.req.param('candidateId');if(!idValid(id)||!idValid(candidateId))return send(err('not_found','candidate not found'));
    const json=await readJson(c);
    return send(await withAdmin(c,'question.candidate_number',{reason:reasonOf(json),target:{type:'question_candidate',id:candidateId}},async(tx,audit)=>{
      const input=parseWith(questionCandidateNumberInputSchema,json);if(!input.ok)return input;
      const result=await recoverCandidateNumber(tx,id,candidateId,input.data);
      if(result.ok)audit.after({candidateId,revision:result.data.candidate.revision,importRevision:result.data.importRevision});
      return result;
    }));
  })
  .post("/imports/:id/contexts/:contextId/resolve", questionFeatureGate("import"), async c => {
    const id=c.req.param('id'), contextId=c.req.param('contextId');if(!idValid(id)||!idValid(contextId))return send(err('not_found','context not found'));
    const json=await readJson(c);
    return send(await withAdmin(c,'question.context_resolve',{reason:reasonOf(json),target:{type:'question_import',id}},async(tx,audit)=>{
      const input=parseWith(questionImportContextResolveInputSchema,json);if(!input.ok)return input;
      const result=await resolveImportContext(tx,id,contextId,input.data);
      if(result.ok)audit.after({contextId,revision:result.data.context.revision,importRevision:result.data.importRevision,decision:input.data.decision});
      return result;
    }));
  })
  .post("/imports/:id/retry", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "import not found"));
    const json = await readJson(c);
    const result = await withAdmin(
      c,
      "question.import_retry",
      { reason: reasonOf(json), target: { type: "question_import", id } },
      async (tx, audit) => {
        const { questionImports: i, questionOutbox: o } = await dbm();
        const [row] = await tx
          .select()
          .from(i)
          .where(eq(i.id, id))
          .for("update");
        if (
          !row ||
          (!["failed", "budget_paused"].includes(row.status) &&
            (![
              "queued",
              "validating",
              "extracting",
              "ocr",
              "segmenting",
              "matching",
            ].includes(row.status) ||
              (row.leaseUntil && row.leaseUntil.getTime() > Date.now())))
        )
          return err("conflict", "import_not_retryable");
        await tx
          .update(i)
          .set({
            status: "queued",
            workerId: null,
            leaseUntil: null,
            errorCode: null,
          })
          .where(eq(i.id, id));
        await tx
          .insert(o)
          .values({
            importId: id,
            eventKey: `question-import:${id}:retry:${row.attempts}`,
            target: "question-import",
            payloadReference: id,
          })
          .onConflictDoNothing();
        audit.before({ status: row.status });
        audit.after({ status: "queued" });
        return ok({ import: (await progress(id, tx))! });
      },
    );
    if (result.ok) await dispatchQuestionImport(id).catch(() => undefined);
    return send(result);
  })
  .post("/imports/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "import not found"));
    const json = await readJson(c);
    return send(
      await withAdmin(
        c,
        "question.import_cancel",
        { reason: reasonOf(json), target: { type: "question_import", id } },
        async (tx, audit) => {
          const { questionImports: i } = await dbm();
          const [row] = await tx
            .select()
            .from(i)
            .where(eq(i.id, id))
            .for("update");
          if (!row || ["completed", "review"].includes(row.status))
            return err("conflict", "import_not_cancellable");
          await tx
            .update(i)
            .set({ status: "cancelled", workerId: null, leaseUntil: null })
            .where(eq(i.id, id));
          audit.before({ status: row.status });
          audit.after({ status: "cancelled" });
          return ok({ import: (await progress(id, tx))! });
        },
      ),
    );
  })
  .get("/imports/:id/candidates/:candidateId/preview", async (c) => {
    const id = c.req.param("id"),
      candidateId = c.req.param("candidateId");
    if (!idValid(id) || !idValid(candidateId))
      return send(err("not_found", "candidate not found"));
    let metadata: Awaited<ReturnType<typeof candidatePreviewMetadata>> = null;
    const result = await withAdmin(
      c,
      "question.import_view",
      {
        reason: "Conferir região privada da questão no PDF original",
        target: { type: "question_candidate", id: candidateId },
      },
      async (tx, audit) => {
        metadata = await candidatePreviewMetadata(tx, id, candidateId);
        if (!metadata) return err("not_found", "candidate not found");
        audit.after({ id: candidateId });
        return ok({ id: candidateId });
      },
    );
    if (!result.ok) return send(result);
    if (!metadata) return send(err("not_found", "candidate not found"));
    const preview = await questionRegionPreview(id, candidateId, metadata);
    return send(ok({ ...preview, audit: result.data.audit }));
  })
  .get(
    "/imports/:id/candidates/:candidateId/crops/:index/preview",
    async (c) => {
      const id = c.req.param("id"),
        candidateId = c.req.param("candidateId"),
        index = Number(c.req.param("index"));
      if (!idValid(id) || !idValid(candidateId))
        return send(err("not_found", "crop not found"));
      return send(
        await withAdmin(
          c,
          "question.import_view",
          {
            reason: "Conferir recorte privado de questão importada",
            target: { type: "question_candidate", id: candidateId },
          },
          async (tx, audit) => {
            const result = await cropPreview(tx, id, candidateId, index);
            audit.after({ id: candidateId, index });
            return result;
          },
        ),
      );
    },
  )
  .post("/:id/rectify", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "question not found"));
    const json = await readJson(c);
    return send(
      await withAdmin(
        c,
        "question.rectify",
        { reason: reasonOf(json), target: { type: "question", id } },
        async (tx, audit) => {
          const input = parseWith(questionPublishInputSchema, json);
          if (!input.ok) return input;
          const result = await rectifyQuestion(tx, id, input.data);
          if (result.ok) audit.after(result.data);
          return result;
        },
      ),
    );
  })
  .post(
    "/imports/:id/candidates/:candidateId/page-image",
    questionFeatureGate("import"),
    async (c) => {
      const id = c.req.param("id"),
        candidateId = c.req.param("candidateId");
      if (!idValid(id) || !idValid(candidateId))
        return send(err("not_found", "candidate not found"));
      const json = await readJson(c),
        opts = {
          reason: reasonOf(json),
          target: { type: "question_candidate" as const, id: candidateId },
        };
      // Denial audit happens before decoding any PDF, exactly as document upload.
      if (!reasonSchema.safeParse(opts.reason).success)
        return send(
          await withAdmin(c, "question.candidate_update", opts, async () =>
            ok({}),
          ),
        );
      const input = parseWith(questionCandidatePageImageInputSchema, json);
      if (!input.ok)
        return send(
          await withAdmin(
            c,
            "question.candidate_update",
            opts,
            async () => input,
          ),
        );
      const result = await withCandidatePageImage(
        id,
        async (claim) => {
          const metadata = await candidatePageImageMetadata(
            id,
            candidateId,
            input.data.page,
            input.data.revision,
            undefined,
            input.data.importRevision,
          );
          if (!metadata.ok)
            return withAdmin(
              c,
              "question.candidate_update",
              opts,
              async () => metadata,
            );
          let prepared:
            Awaited<ReturnType<typeof preparePageImage>> | undefined;
          try {
            const document = metadata.data.document;
            const refs = metadata.data.candidate.payload["imageRefs"];
            const prior = Array.isArray(refs)
              ? refs.find(
                  (r) =>
                    typeof r === "object" &&
                    r !== null &&
                    (r as { page?: unknown; method?: unknown }).page ===
                      input.data.page &&
                    (r as { method?: unknown }).method === "manual_page",
                )
              : undefined;
            const expected =
              prior &&
              typeof prior === "object" &&
              "sha256" in prior &&
              "bytes" in prior &&
              typeof prior.sha256 === "string" &&
              typeof prior.bytes === "number"
                ? { sha256: prior.sha256, bytes: prior.bytes }
                : undefined;
            prepared = await preparePageImage(
              id,
              candidateId,
              {
                id: document.id,
                objectKey: document.objectKey,
                sha256: document.sha256,
                bytes: document.bytes,
                pages: document.pages ?? 0,
              },
              input.data.page,
              expected,
            );
          } catch (error) {
            const key =
              error &&
              typeof error === "object" &&
              "createdObjectKey" in error &&
              typeof error.createdObjectKey === "string"
                ? error.createdObjectKey
                : null;
            if (key)
              await cleanupCandidatePageImage(
                id,
                candidateId,
                key,
                claim,
              ).catch(() =>
                c
                  .get("log")
                  .warn("question page image orphan cleanup pending", {
                    candidateId,
                    page: input.data.page,
                  }),
              );
            const message =
              error instanceof Error && /^page_image_/.test(error.message)
                ? error.message
                : "page_image_render_failed";
            const operational =
              /^page_image_(storage|cached|document_unavailable|layout_timeout|render_timeout|render_unavailable|render_failed)/.test(
                message,
              );
            return withAdmin(c, "question.candidate_update", opts, async () =>
              err(operational ? "internal" : "validation", message),
            );
          }
          try {
            return await withAdmin(
              c,
              "question.candidate_update",
              opts,
              async (tx, audit) => {
                const { profiles } = await dbm();
                const [actor] = await tx
                  .select()
                  .from(profiles)
                  .where(eq(profiles.userId, c.get("admin").id))
                  .for("share");
                if (
                  !actor ||
                  actor.role !== "admin" ||
                  actor.deletedAt ||
                  actor.suspendedAt
                )
                  return err("not_found", "route not found");
                const r = await appendCandidatePageImage(
                  tx,
                  id,
                  candidateId,
                  input.data.revision,
                  claim,
                  prepared!,
                  input.data.importRevision,
                );
                if (r.ok) {
                  audit.before({ revision: input.data.revision });
                  audit.after({
                    revision: r.data.candidate.revision,
                    page: input.data.page,
                    documentId: prepared!.documentId,
                    sha256: prepared!.sha256,
                    bytes: prepared!.bytes,
                    method: "manual_page",
                  });
                }
                return r;
              },
            );
          } finally {
            if (prepared?.created)
              await cleanupCandidatePageImage(
                id,
                candidateId,
                prepared.objectKey,
                claim,
              ).catch(() =>
                c
                  .get("log")
                  .warn("question page image orphan cleanup pending", {
                    candidateId,
                    page: input.data.page,
                  }),
              );
          }
        },
        (message) =>
          withAdmin(c, "question.candidate_update", opts, async () =>
            err(
              message === "page_image_capacity" ? "rate_limited" : "conflict",
              message,
            ),
          ),
      );
      if (!result.ok && result.error.code === "internal")
        return Response.json(
          { error: result.error },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      return send(result);
    },
  )
  .patch("/imports/:id/candidates/:candidateId", async (c) => {
    const id = c.req.param("id"),
      candidateId = c.req.param("candidateId");
    if (!idValid(id) || !idValid(candidateId))
      return send(err("not_found", "candidate not found"));
    const json = await readJson(c);
    return send(
      await withAdmin(
        c,
        "question.candidate_update",
        {
          reason: reasonOf(json),
          target: { type: "question_candidate", id: candidateId },
        },
        async (tx, audit) => {
          const input = parseWith(importCandidateReviewInputSchema, json);
          if (!input.ok) return input;
          const result = await updateCandidate(tx, id, candidateId, input.data);
          if (result.ok)
            audit.after({
              questionId: result.data.questionId,
              state: input.data.state,
            });
          return result;
        },
      ),
    );
  })
  // D-1841: batch accept (one reason, one audit row, per-item outcomes). Runs only on an admin's click.
  .post("/imports/:id/candidates/accept", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "import not found"));
    const json = await readJson(c);
    return send(
      await withAdmin(c, "question.candidate_update", { reason: reasonOf(json), target: { type: "question_import", id } }, async (tx, audit) => {
        const input = parseWith(questionCandidateAcceptInputSchema, json);
        return input.ok ? acceptCandidates(tx, id, input.data, audit) : input;
      }),
    );
  })
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "question not found"));
    const json = await readJson(c);
    const content =
      json && typeof json === "object" && "content" in json
        ? json.content
        : null;
    return send(
      await withAdmin(
        c,
        "question.candidate_update",
        { reason: reasonOf(content), target: { type: "question", id } },
        async (tx, audit) => {
          const input = parseWith(questionDraftUpdateInputSchema, json);
          if (!input.ok) return input;
          const result = await updateQuestionDraft(
            tx,
            id,
            input.data.content,
            input.data.expectedContentHash,
          );
          if (result.ok) audit.after(result.data);
          return result;
        },
      ),
    );
  })
  .post("/:id/publish", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "question not found"));
    const json = await readJson(c);
    return send(
      await withAdmin(
        c,
        "question.publish",
        { reason: reasonOf(json), target: { type: "question", id } },
        async (tx, audit) => {
          const input = parseWith(questionPublishInputSchema, json);
          if (!input.ok) return input;
          const result = await publishQuestion(tx, id, input.data, audit.after);
          return result;
        },
      ),
    );
  })
  .post("/:id/withdraw", async (c) => {
    const id = c.req.param("id");
    if (!idValid(id)) return send(err("not_found", "question not found"));
    const json = await readJson(c);
    return send(
      await withAdmin(
        c,
        "question.withdraw",
        { reason: reasonOf(json), target: { type: "question", id } },
        async (tx, audit) => {
          const { questionBank: q } = await dbm();
          const [row] = await tx
            .update(q)
            .set({ catalogStatus: "withdrawn" })
            .where(and(eq(q.id, id), eq(q.visibility, "public")))
            .returning({ id: q.id });
          if (!row) return err("not_found", "question not found");
          audit.after({ status: "withdrawn" });
          return ok({ id, status: "withdrawn" });
        },
      ),
    );
  })
  .get("/metrics", async (c) =>
    send(
      await withAdmin(
        c,
        "question.import_view",
        {
          reason: "Consultar métricas auditáveis do acervo de questões",
          target: { type: "route", id: c.req.path },
        },
        async (tx, audit) => {
          const {
            questionBank: q,
            questionImports: i,
            questionImportCandidates: c,
            questionDocuments: d,
          } = await dbm();
          // Share the catalog's exact canonical/rights/chain selection; an unpublished clone cannot shrink capacity.
          const [capacity]=await tx.execute<CatalogCapacity>(catalogCapacitySQL());
          const importsByStatus = await tx
            .select({ status: i.status, count: count() })
            .from(i)
            .groupBy(i.status);
          const candidateCounts = await tx
            .select({ state: c.state, count: count() })
            .from(c)
            .groupBy(c.state);
          const [documents] = await tx.select({ n: count() }).from(d);
          const [privateAi] = await tx
            .select({ n: count() })
            .from(q)
            .where(
              and(eq(q.visibility, "private"), eq(q.origin, "ai_generated")),
            );
          audit.after({ publicCanonical: Number(capacity?.public_canonical ?? 0) });
          return ok({
            publicCanonical: Number(capacity?.public_canonical ?? 0),
            acervoCoverage: questionAcervoCoverageSchema.parse(capacity?.acervo_coverage),
            importsByStatus,
            candidateCounts,
            documents: Number(documents?.n ?? 0),
            generatedPrivate: Number(privateAi?.n ?? 0),
            duplicateOrVersionNotCounted: true,
            publicByOrigin:questionOrigins.map(origin=>({origin,count:Number(capacity?.origins.find(r=>r.origin===origin)?.count??0)})),
            coverageByArea:(capacity?.areas??[]).slice(0,500),
            coverageByTopic:(capacity?.topics??[]).slice(0,500),
            coverageTruncated:(capacity?.areas.length??0)>500 || (capacity?.topics.length??0)>500,
          });
        },
      ),
    ),
  )
  .all("*", () => send(err("not_found", "route not found")));
