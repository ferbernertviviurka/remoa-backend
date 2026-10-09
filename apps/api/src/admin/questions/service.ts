import { answerKeyPageSelection, reusableAnswerKeyScope } from '../../questions/imports/answer-key-scope';
import { QUESTION_PDF_OCR_VERSION } from "@remoa/contracts";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import {
  err,
  ok,
  type Result,
  type ImportCandidateReviewInput,
  type QuestionImportInput,
  type QuestionPublishInput,
} from "@remoa/contracts";
import type { Tx } from "@remoa/db";
import { dbm } from "../../db";
import { readPdfLayout, readPdfPageGeometry } from "@remoa/ai";
import {
  putBytes,
  presignGet,
  getBytes,
  headObject,
  deleteObject,
} from "../../storage/storage";
import {
  assertCandidate,
  assertPublish,
  contentHash,
  isContextManaged,
  contextStructureChanged,
  fingerprint,
  duplicateMatches,
  PARSER_VERSION,
  sha256,
} from "../../questions/imports/domain";
export const idValid = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
export async function progress(id: string, tx?: Tx) {
  const { db, questionImports: i, questionImportCandidates: c } = await dbm();
  const [r] = await (tx ?? db).select().from(i).where(eq(i.id, id));
  if (!r) return null;
  const [stats] = await (tx ?? db)
    .select({
      candidates: count(),
      accepted: sql<number>`count(*) filter(where ${c.state}='accepted')`,
      rejected: sql<number>`count(*) filter(where ${c.state}='rejected')`,
      duplicate: sql<number>`count(*) filter(where ${c.state}='duplicate')`,
    })
    .from(c)
    .where(eq(c.importId, id));
  return {
    id: r.id,
    status: r.status,
    totalPages: r.totalPages,
    completedPages: r.completedPages,
    candidates: Number(stats?.candidates ?? 0),
    accepted: Number(stats?.accepted ?? 0),
    rejected: Number(stats?.rejected ?? 0),
    duplicate: Number(stats?.duplicate ?? 0),
    costCents: r.costCents,
    errorCode: r.errorCode,
    updatedAt: r.updatedAt,
    revision: r.revision,
    answerKeyPages: r.answerKeyPages ?? null,
  };
}
export interface PreparedDocument {
  id: string;
  actorId: string;
  sourceId: string;
  kind: "exam" | "answer_key";
  objectKey: string;
  sha256: string;
  bytes: number;
  pages: number;
}
/** Expensive PDF decoding and object storage happen before the short audit transaction. */
export async function prepareDocument(
  actorId: string,
  sourceId: string,
  kind: "exam" | "answer_key",
  bytes: Uint8Array,
): Promise<Result<PreparedDocument>> {
  const { db, questionSourcesCatalog: s } = await dbm();
  if (
    !bytes.length ||
    bytes.length > 104857600 ||
    new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
  )
    return err("validation", "invalid_pdf_or_size");
  if (!(await db.select({ id: s.id }).from(s).where(eq(s.id, sourceId)))[0])
    return err("not_found", "source not found");
  let pages: number;
  try {
    pages = (await readPdfLayout(bytes, {allowFontMetricOcr:true})).pages.length;
  } catch {
    return err("validation", "pdf_unreadable");
  }
  if (!pages || pages > 500) return err("validation", "page_limit");
  const id = crypto.randomUUID(),
    objectKey = `questions/documents/${actorId}/${id}.pdf`;
  try {
    await putBytes(objectKey, Buffer.from(bytes), "application/pdf");
  } catch {
    await deleteObject(objectKey).catch(() => undefined);
    return err("internal", "storage_upload_failed");
  }
  return ok({
    id,
    actorId,
    sourceId,
    kind,
    objectKey,
    sha256: sha256(bytes),
    bytes: bytes.length,
    pages,
  });
}
export async function uploadDocument(tx: Tx, prepared: PreparedDocument) {
  const { questionSourcesCatalog: s, questionDocuments: d } = await dbm();
  if (
    !(
      await tx.select({ id: s.id }).from(s).where(eq(s.id, prepared.sourceId))
    )[0]
  )
    return err("not_found", "source not found");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`question-upload:${prepared.actorId}:${prepared.sourceId}:${prepared.sha256}:${prepared.kind}`}))`,
  );
  const [previous] = await tx
    .select()
    .from(d)
    .where(
      and(
        eq(d.sourceId, prepared.sourceId),
        eq(d.actorId, prepared.actorId),
        eq(d.sha256, prepared.sha256),
        eq(d.kind, prepared.kind),
      ),
    );
  const document =
    previous ?? (await tx.insert(d).values(prepared).returning())[0]!;
  return ok({
    document: {
      id: document.id,
      kind: document.kind,
      sha256: document.sha256,
      bytes: document.bytes,
      pages: document.pages,
    },
  });
}
export async function createImport(
  tx: Tx,
  actorId: string,
  input: QuestionImportInput,
  key: string,
): Promise<
  Result<{
    import: NonNullable<Awaited<ReturnType<typeof progress>>>;
    paperId: string;
  }>
> {
  const {
    questionImports: i,
    questionDocuments: d,
    examPapers: p,
    questionOutbox: o,
  } = await dbm();
  if (!key || key.length > 300 || input.parserVersion !== PARSER_VERSION)
    return err("validation", "idempotency_key_or_parser_version");
  let answerKeyPages: number[] | null;
  try { answerKeyPages = answerKeyPageSelection(input.answerKeyPages, input.answerKeyDocumentId); }
  catch { return err('validation', 'answer_key_pages_invalid'); }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('question-import-admission'))`,
  );
  const [existing] = await tx
    .select()
    .from(i)
    .where(and(eq(i.actorId, actorId), eq(i.idempotencyKey, key)));
  if (existing) {
    const [originalPaper] = existing.paperId
      ? await tx.select().from(p).where(eq(p.id, existing.paperId))
      : [];
    if (
      !originalPaper ||
      Object.entries(input.exam).some(
        ([field, value]) =>
          originalPaper[field as keyof typeof originalPaper] !== value,
      )
    )
      return err("conflict", "idempotency_key_payload_changed");
    if (
      existing.documentId !== input.documentId ||
      existing.answerKeyDocumentId !== input.answerKeyDocumentId ||
      JSON.stringify(existing.answerKeyPages ?? null) !== JSON.stringify(answerKeyPages) ||
      existing.sourceId !== input.sourceId ||
      existing.parserVersion !== input.parserVersion ||
      existing.ocrEnabled !== input.ocr ||
      existing.budgetCents !== input.budgetCents ||
      JSON.stringify(existing.excludedPages) !==
        JSON.stringify(input.excludedPages)
    )
      return err("conflict", "idempotency_key_payload_changed");
    return ok({
      import: (await progress(existing.id, tx))!,
      paperId: existing.paperId!,
    });
  }
  const [active] = await tx
    .select({
      all: count(),
      mine: sql<number>`count(*) filter(where ${i.actorId}=${actorId})`,
    })
    .from(i)
    .where(
      sql`${i.status} in ('queued','validating','extracting','ocr','segmenting','matching')`,
    );
  if (Number(active?.all ?? 0) >= 5 || Number(active?.mine ?? 0) >= 1)
    return err("rate_limited", "import_concurrency_limit");
  const [exam] = await tx
    .select()
    .from(d)
    .where(
      and(
        eq(d.id, input.documentId),
        eq(d.sourceId, input.sourceId),
        eq(d.kind, "exam"),
      ),
    );
  if (!exam) return err("not_found", "exam document not found");
  const [keyDocument] = input.answerKeyDocumentId ? await tx.select({ id: d.id, pages: d.pages }).from(d).where(and(eq(d.id,input.answerKeyDocumentId),eq(d.sourceId,input.sourceId),eq(d.kind,'answer_key'))) : [];
  if (input.answerKeyDocumentId && !keyDocument) return err('not_found','answer-key document not found');
  if (answerKeyPages && (!keyDocument?.pages || answerKeyPages.some(page => page > keyDocument.pages!))) return err('validation','answer_key_page_out_of_range');
  if (input.excludedPages.some((page) => page > (exam.pages ?? 0)))
    return err("validation", "excluded_page_out_of_range");
  const [last] = await tx
    .select()
    .from(p)
    .where(
      and(
        eq(p.sourceId, input.sourceId),
        eq(p.edition, input.exam.edition),
        eq(p.booklet, input.exam.booklet),
      ),
    )
    .orderBy(desc(p.version))
    .limit(1);
  const previousPlans = last ? await tx.select({ answerKeyDocumentId: i.answerKeyDocumentId, answerKeyPages: i.answerKeyPages }).from(i).where(eq(i.paperId,last.id)).limit(1001) : [];
  const paperId =
    last?.documentId === exam.id &&
    last.status === "draft" &&
    last.answerKeyDocumentId === input.answerKeyDocumentId &&
    reusableAnswerKeyScope(previousPlans,input.answerKeyDocumentId,answerKeyPages) &&
    Object.entries(input.exam).every(
      ([field, value]) => last[field as keyof typeof last] === value,
    )
      ? last.id
      : crypto.randomUUID();
  if (paperId !== last?.id)
    await tx.insert(p).values({
      id: paperId,
      sourceId: input.sourceId,
      documentId: exam.id,
      answerKeyDocumentId: input.answerKeyDocumentId,
      ...input.exam,
      version: (last?.version ?? 0) + 1,
    });
  const id = crypto.randomUUID();
  await tx.insert(i).values({
    id,
    actorId,
    sourceId: input.sourceId,
    paperId,
    documentId: exam.id,
    answerKeyDocumentId: input.answerKeyDocumentId,
    answerKeyPages,
    idempotencyKey: key,
    parserVersion: PARSER_VERSION,
    ocrVersion: QUESTION_PDF_OCR_VERSION,
    ocrEnabled: input.ocr,
    excludedPages: input.excludedPages,
    budgetCents: input.budgetCents,
    totalPages: exam.pages ?? 0,
  });
  await tx.insert(o).values({
    importId: id,
    eventKey: `question-import:${id}`,
    target: "question-import",
    payloadReference: id,
  });
  return ok({ import: (await progress(id, tx))!, paperId });
}
export async function importDetail(tx: Tx, id: string) {
  const {
    questionImports: i,
    examPapers: p,
    questionImportCandidates: c,
    questionDocuments: d,
    questionImportContexts: contextsTable,
  } = await dbm();
  const [job] = await tx.select().from(i).where(eq(i.id, id));
  if (!job) return null;
  const [paper] = job.paperId
    ? await tx.select().from(p).where(eq(p.id, job.paperId))
    : [];
  const candidates = await tx
    .select()
    .from(c)
    .where(eq(c.importId, id))
    .orderBy(c.ordinal)
    .limit(1000);
  const documents = await tx
    .select({
      id: d.id,
      kind: d.kind,
      pages: d.pages,
      bytes: d.bytes,
      sha256: d.sha256,
    })
    .from(d)
    .where(sql`${d.id} in (${job.documentId},${job.answerKeyDocumentId})`);
  const contexts = await tx.select().from(contextsTable).where(eq(contextsTable.importId, id)).orderBy(contextsTable.id);
  for (const context of contexts) for (const ref of context.imageRefs) if (typeof ref.objectKey === 'string') ref.url = await presignGet(ref.objectKey);
  candidates.sort((a,b) => Number(a.originalNumber ?? 1000)-Number(b.originalNumber ?? 1000) || a.ordinal-b.ordinal);
  return {
    contexts,
    acceptanceBlocked: contexts.some(c => c.status === 'unresolved'),
    import: await progress(id, tx),
    paper: paper ?? null,
    candidates,
    documents,
  };
}
export async function updateCandidate(
  tx: Tx,
  importId: string,
  id: string,
  input: ImportCandidateReviewInput,
): Promise<Result<{ candidate: unknown; questionId: string | null }>> {
  const {
    questionImportCandidates: c,
    questionBank: q,
    examQuestionOccurrences: o,
    examPapers: p,
    enamedTaxonomy: t,
    questionSourcesCatalog: s,
  } = await dbm();
  const recovered = await recoveryState(tx, importId, input.importRevision, input.state === "duplicate" && input.duplicateOf ? [input.duplicateOf] : []);
  if (!recovered.ok) return recovered;
  const state = recovered.data;
  const candidate = state.candidates.find(c => c.id === id);
  const job = { ...state.job, paperId: state.job.paperId! };
  if (!candidate) return err("not_found", "candidate not found");
  if (candidate.revision !== input.revision || job.revision !== input.importRevision)
    return err("conflict", "candidate_or_import_revision_changed");
  if (frozenRecovery(state)) return err("conflict", "published_requires_new_version");
  if (["accepted", "duplicate"].includes(input.state) && state.contexts.some(c => c.status === "unresolved"))
    return err("validation", "shared_context_resolution_required");
  const hasContext = state.contexts.some(c => c.status === "bound" && Array.isArray(c.resolution?.targetNumbers) && c.resolution!.targetNumbers.includes(Number(candidate.originalNumber)));
  if (hasContext && input.ownStem === undefined) return err("validation", "context_own_stem_required");
  const ownStem = input.ownStem ?? input.stem;
  const composed = effectiveStem(ownStem, state.contexts.filter(c => c.status === "bound" && Array.isArray(c.resolution?.targetNumbers) && c.resolution!.targetNumbers.includes(Number(candidate.originalNumber))));
  if (!composed.ok) return composed;
  input = { ...input, ownStem, stem: composed.data };
  try {
    assertCandidate(input, candidate.payload);
  } catch (e) {
    return err(
      "validation",
      e instanceof Error ? e.message : "invalid_candidate",
    );
  }
  const priorQuestion = state.questions.find(q=>q.id===candidate.questionId);
  const leavingPublishedDuplicate = candidate.state === 'duplicate' && input.state !== 'duplicate' && Boolean(priorQuestion?.publishedAt || priorQuestion?.catalogStatus === 'published');
  let questionId = leavingPublishedDuplicate ? null : candidate.questionId;
  const extra = input as ImportCandidateReviewInput & {
    imagesConfirmed?: boolean;
    assets?: {
      id: string;
      objectKey: string;
      alt: string;
      provenance: unknown;
    }[];
  };
  const assets = extra.assets ?? [];
  const refs = (candidate.payload["imageRefs"] ?? []) as {
    objectKey?: string;
    method?: string;
  }[];
  if (
    assets.some(
      (a) =>
        !a.objectKey.startsWith(`questions/imports/${importId}/crops/`) ||
        !refs.some((r) => r.objectKey === a.objectKey) ||
        !a.alt.trim(),
    )
  )
    return err("validation", "asset_not_from_candidate");
  if (
    ["accepted", "duplicate"].includes(input.state) &&
    refs.some(
      (ref) =>
        ref.method === "manual_page" &&
        !assets.some(
          (asset) => asset.objectKey === ref.objectKey && asset.alt.trim(),
        ),
    )
  )
    return err("validation", "manual_page_asset_required");
  if (input.state === "duplicate") {
    if (refs.some((ref) => ref.method === "manual_page"))
      return err(
        "validation",
        "manual_page_requires_preserved_asset_and_new_medical_review",
      );
    if (!input.duplicateOf)
      return err("validation", "duplicate_target_required");
    const [target] = await tx
      .select()
      .from(q)
      .where(
        and(
          eq(q.id, input.duplicateOf),
          eq(q.visibility, "public"),
          isNull(q.userId),
        ),
      );
    if (
      !target ||
      !duplicateMatches(input, target) ||
      target.catalogStatus !== "published" ||
      target.rightsStatus !== "authorized"
    )
      return err("validation", "duplicate_content_mismatch");
    questionId = target.id;
  } else if (input.state === "accepted") {
    const tags = await tx
      .select({ id: t.id, kind: t.kind, area: t.area, parentId: t.parentId })
      .from(t)
      .where(sql`${t.id} in (${input.areaId},${input.topicId})`);
    if (
      !tags.some((a) => a.id === input.areaId && a.kind === "area") ||
      !tags.some((a) => a.id === input.topicId && a.kind === "topic")
    )
      return err("validation", "invalid_taxonomy");
    const area = tags.find((a) => a.id === input.areaId)!;
    let node = tags.find((a) => a.id === input.topicId)!;
    const visited = new Set<string>();
    while (node.parentId && node.id !== area.id) {
      if (node.area !== area.area || visited.has(node.id))
        return err("validation", "taxonomy_area_mismatch");
      visited.add(node.id);
      const [parent] = await tx
        .select({ id: t.id, kind: t.kind, area: t.area, parentId: t.parentId })
        .from(t)
        .where(eq(t.id, node.parentId));
      if (!parent) return err("validation", "taxonomy_parent_missing");
      node = parent;
    }
    if (node.id !== area.id) return err("validation", "taxonomy_area_mismatch");
    const [source] = await tx.select().from(s).where(eq(s.id, job.sourceId));
    if (!source) return err("not_found", "source not found");
    const payload = {
      stem: input.stem,
      alternatives: input.alternatives,
      correctKey: input.annulled ? null : input.correctKey,
      explanation: input.explanation,
      areaId: input.areaId,
      topicId: input.topicId,
      annulled: input.annulled,
      assets,
    };
    const hash = contentHash(payload);
    const [old] = questionId
      ? await tx.select().from(q).where(eq(q.id, questionId)).for("update")
      : [];
    if (old?.catalogStatus === "published")
      return err("conflict", "published_requires_new_version");
    if (!old) {
      questionId = crypto.randomUUID();
      await tx.insert(q).values({
        id: questionId,
        userId: null,
        canonicalId: questionId,
        sourceId: job.sourceId,
        type: "objective",
        difficulty: "medium",
        stem: input.stem,
        alternatives: input.alternatives,
        correctKey: input.annulled ? null : input.correctKey,
        expectedAnswer: "",
        explanation: input.explanation,
        source: "student",
        origin: "official_exam",
        visibility: "public",
        catalogStatus: "in_review",
        rightsStatus: source.rightsStatus,
        availability: input.annulled ? "annulled" : "active",
        contentHash: hash,
        fingerprint: fingerprint(input.stem, input.alternatives),
        integrityConfirmed: input.integrityConfirmed,
        keyFinal: input.keyFinal,
        enamedConfirmed: true,
        enamedAreaId: input.areaId,
        enamedTopicId: input.topicId,
        assets,
      });
    } else
      await tx
        .update(q)
        .set({
          stem: input.stem,
          alternatives: input.alternatives,
          correctKey: input.annulled ? null : input.correctKey,
          explanation: input.explanation,
          availability: input.annulled ? "annulled" : "active",
          contentHash: hash,
          fingerprint: fingerprint(input.stem, input.alternatives),
          integrityConfirmed: input.integrityConfirmed,
          keyFinal: input.keyFinal,
          enamedConfirmed: true,
          enamedAreaId: input.areaId,
          enamedTopicId: input.topicId,
          assets,
          status: "draft",
          catalogStatus: "in_review",
          reviewedHash: null,
          reviewerName: null,
          reviewerCrm: null,
          referenceDate: null,
        })
        .where(eq(q.id, old.id));
  }
  if (questionId && (input.state === "accepted" || input.state === "duplicate"))
    await tx
      .insert(o)
      .values({
        paperId: job.paperId,
        questionId,
        ordinal: candidate.ordinal,
        originalNumber: candidate.originalNumber ?? String(candidate.ordinal),
        originalKeys: {
          alternatives: input.alternatives,
          correctKey: input.correctKey,
        },
        annulled: input.annulled,
        provenance: candidate.provenance,
      })
      .onConflictDoUpdate({
        target: [o.paperId, o.originalNumber],
        set: {
          questionId,
          annulled: input.annulled,
          originalKeys: {
            alternatives: input.alternatives,
            correctKey: input.correctKey,
          },
          provenance: candidate.provenance,
        },
      });
  if (!['accepted','duplicate'].includes(input.state) && candidate.questionId) {
    await tx.delete(o).where(and(eq(o.paperId,job.paperId),eq(o.originalNumber,candidate.originalNumber??String(candidate.ordinal)),eq(o.questionId,candidate.questionId)));
    const linkedQuestion=state.questions.find(q=>q.id===candidate.questionId);
    if(linkedQuestion && !linkedQuestion.publishedAt && linkedQuestion.catalogStatus!=='published')
      await tx.update(q).set({catalogStatus:input.state==='rejected'?'rejected':'in_review',status:'draft',integrityConfirmed:false,keyFinal:false,reviewedHash:null,reviewerName:null,reviewerCrm:null,referenceDate:null}).where(eq(q.id,linkedQuestion.id));
  }
  await tx
    .update(p)
    .set({ keyFinal: input.keyFinal })
    .where(eq(p.id, job.paperId));
  const [updated] = await tx
    .update(c)
    .set({
      payload: {
        ...candidate.payload,
        ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'importRevision')),
        duplicateOf: input.state === 'duplicate' ? input.duplicateOf : null,
        assets,
        imagesConfirmed: extra.imagesConfirmed ?? false,
      },
      state: input.state,
      questionId,
      duplicateOf: input.state === 'duplicate' ? input.duplicateOf : null,
      revision: candidate.revision + 1,
      issues: input.integrityConfirmed ? [] : candidate.issues,
    })
    .where(eq(c.id, id))
    .returning();
  const ranks = await orderDraftOccurrences(tx, state);
  if (!ranks.ok) return ranks;
  return ok({ candidate: updated, questionId, importRevision: await bumpImport(tx, state), affectedCandidates: [] });
}
export async function publishQuestion(
  tx: Tx,
  id: string,
  input: QuestionPublishInput,
  onPublished?: (details: Record<string, unknown>) => void,
) {
  const {
    questionBank: q,
    questionSourcesCatalog: s,
    questionEditorialReviews: r,
    examPapers: p,
    examQuestionOccurrences: o,
    questionImportCandidates: c,
    questionImports: i,
  } = await dbm();
  const locked = await lockPublicationQuestionGraph(tx, id);
  if (!locked.ok) return locked;
  const [row] = await tx.select().from(q).where(eq(q.id, id)).for("update");
  if (!row || !row.sourceId) return err("not_found", "question not found");
  if (
    row.version !== input.revision ||
    row.contentHash !== input.expectedContentHash
  )
    return err("conflict", "question_revision_changed");
  const [source] = await tx.select().from(s).where(eq(s.id, row.sourceId));
  const [latest] = await tx
    .select()
    .from(r)
    .where(eq(r.questionId, id))
    .orderBy(desc(r.reviewedAt), desc(r.id))
    .limit(1);
  if (!source) return err("not_found", "source not found");
  if (
    row.publishedAt &&
    latest?.decision === "approved" &&
    (latest.reviewerName !== row.reviewerName ||
      latest.reviewerCrm !== row.reviewerCrm ||
      latest.referenceDate !== row.referenceDate ||
      latest.contentHash !== row.reviewedHash)
  )
    return err("conflict", "medical_signature_changed_create_version");
  try {
    assertPublish(row, source, latest, input.expectedContentHash);
  } catch (e) {
    return err("conflict", e instanceof Error ? e.message : "publication_gate");
  }
  const withdrawnPaperIds: string[] = [];
  if (row.supersedesId) {
    const [old] = await tx
      .select()
      .from(q)
      .where(eq(q.id, row.supersedesId))
      .for("update");
    if (
      !old ||
      old.visibility !== "public" ||
      old.userId !== null ||
      old.sourceId !== row.sourceId ||
      (old.canonicalId ?? old.id) !== (row.canonicalId ?? row.id) ||
      row.version !== old.version + 1
    )
      return err("conflict", "invalid_superseding_chain");
    if (old.availability === "active")
      await tx
        .update(q)
        .set({ availability: "superseded" })
        .where(eq(q.id, old.id));
    const affected = await tx
      .select({ id: o.paperId })
      .from(o)
      .where(eq(o.questionId, old.id));
    for (const paper of affected) {
      await tx.update(p).set({ status: "withdrawn" }).where(eq(p.id, paper.id));
      withdrawnPaperIds.push(paper.id);
    }
  }
  await tx
    .update(q)
    .set({ catalogStatus: "published", publishedAt: new Date() })
    .where(eq(q.id, id));
  const papers = await tx
    .select({ paperId: o.paperId })
    .from(o)
    .where(eq(o.questionId, id));
  for (const paper of papers) {
    const [remaining] = await tx
      .select({ n: count() })
      .from(o)
      .innerJoin(q, eq(o.questionId, q.id))
      .where(
        and(eq(o.paperId, paper.paperId), sql`${q.catalogStatus}<>'published'`),
      );
    const [pending] = await tx
      .select({ n: count() })
      .from(c)
      .innerJoin(i, eq(c.importId, i.id))
      .where(
        and(
          eq(i.paperId, paper.paperId),
          sql`${c.state} not in ('accepted','duplicate')`,
        ),
      );
    if (Number(remaining?.n ?? 0) === 0 && Number(pending?.n ?? 0) === 0)
      await tx
        .update(p)
        .set({ status: "published" })
        .where(eq(p.id, paper.paperId));
  }
  onPublished?.({
    id,
    status: "published",
    supersedesId: row.supersedesId,
    withdrawnPaperIds,
  });
  return ok({ id, status: "published" });
}
export async function documentPreview(tx: Tx, id: string) {
  const { questionDocuments: d } = await dbm();
  const [row] = await tx.select().from(d).where(eq(d.id, id));
  return row
    ? ok({
        id: row.id,
        url: await presignGet(row.objectKey),
        expiresInSec: 3600,
      })
    : err("not_found", "document not found");
}

export async function cropPreview(
  tx: Tx,
  importId: string,
  id: string,
  index: number,
) {
  const { questionImportCandidates: c } = await dbm();
  const [row] = await tx
    .select({ payload: c.payload })
    .from(c)
    .where(and(eq(c.id, id), eq(c.importId, importId)));
  if (!row) return err("not_found", "candidate not found");
  const refs = row.payload["imageRefs"];
  if (
    !Array.isArray(refs) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= refs.length
  )
    return err("not_found", "crop not found");
  const ref = refs[index] as { objectKey?: string };
  if (!ref.objectKey?.startsWith(`questions/imports/${importId}/crops/`))
    return err("not_found", "crop not found");
  return ok({ id, url: await presignGet(ref.objectKey), expiresInSec: 3600 });
}
export async function rectifyQuestion(
  tx: Tx,
  id: string,
  input: QuestionPublishInput,
) {
  const { questionBank: q } = await dbm();
  const [old] = await tx
    .select()
    .from(q)
    .where(and(eq(q.id, id), eq(q.visibility, "public"), isNull(q.userId)))
    .for("update");
  if (!old) return err("not_found", "question not found");
  if (
    old.contentHash !== input.expectedContentHash ||
    old.version !== input.revision
  )
    return err("conflict", "question_revision_changed");
  const [existing] = await tx
    .select({ id: q.id })
    .from(q)
    .where(eq(q.supersedesId, id));
  if (existing) return err("conflict", "new_version_already_exists");
  const newId = crypto.randomUUID();
  await tx.insert(q).values({
    ...old,
    id: newId,
    canonicalId: old.canonicalId ?? old.id,
    supersedesId: old.id,
    version: old.version + 1,
    catalogStatus: "in_review",
    status: "draft",
    reviewedHash: null,
    reviewerName: null,
    reviewerCrm: null,
    referenceDate: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return ok({ id: newId, version: old.version + 1, supersedesId: id });
}

export async function updateQuestionDraft(
  tx: Tx,
  id: string,
  input: ImportCandidateReviewInput,
  expectedContentHash: string,
) {
  const { questionBank: q, enamedTaxonomy: t, questionImportCandidates: staging } = await dbm();
  // Linked staging writers acquire the import graph before the question row.
  const locked = await lockAssociatedQuestionGraphs(tx, id);
  if (!locked.ok) return locked;
  const [row] = await tx
    .select()
    .from(q)
    .where(and(eq(q.id, id), eq(q.visibility, "public"), isNull(q.userId)))
    .for("update");
  if (!row) return err("not_found", "question not found");
  if (row.catalogStatus === "published" || row.publishedAt)
    return err("conflict", "published_requires_new_version");
  if (row.version !== input.revision || row.contentHash !== expectedContentHash)
    return err("conflict", "question_revision_changed");
  if (input.state !== "accepted" || input.duplicateOf)
    return err("validation", "draft_requires_accepted_content");
  try {
    assertCandidate(input, {
      imageRefs: Array.isArray(row.assets) && row.assets.length ? [{}] : [],
    });
  } catch (e) {
    return err(
      "validation",
      e instanceof Error ? e.message : "invalid_candidate",
    );
  }
  const linked = await tx.select({payload:staging.payload}).from(staging).where(eq(staging.questionId,id));
  if (linked.some(c=>isContextManaged(c.payload)) && contextStructureChanged(input, row))
    return err("validation","context_requires_staging_review");
  const nodes = await tx.select().from(t);
  const area = nodes.find((n) => n.id === input.areaId && n.kind === "area");
  let topic = nodes.find((n) => n.id === input.topicId && n.kind === "topic");
  if (!area || !topic) return err("validation", "invalid_taxonomy");
  const visited = new Set<string>();
  while (topic?.parentId && topic.id !== area.id) {
    if (topic.area !== area.area || visited.has(topic.id))
      return err("validation", "taxonomy_area_mismatch");
    visited.add(topic.id);
    topic = nodes.find((n) => n.id === topic!.parentId);
  }
  if (topic?.id !== area.id) return err("validation", "taxonomy_area_mismatch");
  const assets =
    input.assets ??
    ((Array.isArray(row.assets) ? row.assets : []) as NonNullable<
      ImportCandidateReviewInput["assets"]
    >);
  const oldAssets = (row.assets ?? []) as { objectKey?: string }[];
  if (
    assets.some((a) => !oldAssets.some((old) => old.objectKey === a.objectKey))
  )
    return err("validation", "asset_not_from_question");
  const hash = contentHash({
    stem: input.stem,
    alternatives: input.alternatives,
    correctKey: input.annulled ? null : input.correctKey,
    explanation: input.explanation,
    areaId: input.areaId,
    topicId: input.topicId,
    annulled: input.annulled,
    assets,
  });
  await tx
    .update(q)
    .set({
      stem: input.stem,
      alternatives: input.alternatives,
      correctKey: input.annulled ? null : input.correctKey,
      explanation: input.explanation,
      enamedAreaId: input.areaId,
      enamedTopicId: input.topicId,
      availability: input.annulled ? "annulled" : "active",
      integrityConfirmed: input.integrityConfirmed,
      keyFinal: input.keyFinal,
      enamedConfirmed: true,
      assets,
      contentHash: hash,
      fingerprint: fingerprint(input.stem, input.alternatives),
      catalogStatus: "in_review",
      status: "draft",
      reviewedHash: null,
      reviewerName: null,
      reviewerCrm: null,
      referenceDate: null,
    })
    .where(eq(q.id, id));
  const [updated] = await tx.select().from(q).where(eq(q.id, id));
  const { reviewDto } = await import("../../questions/editorial/service");
  return ok({ question: await reviewDto(updated!) });
}

export async function candidatePreviewMetadata(
  tx: Tx,
  importId: string,
  id: string,
) {
  const {
    questionImportCandidates: c,
    questionImports: i,
    questionDocuments: d,
  } = await dbm();
  const [row] = await tx
    .select({ payload: c.payload, objectKey: d.objectKey, sha256: d.sha256 })
    .from(c)
    .innerJoin(i, eq(c.importId, i.id))
    .innerJoin(d, eq(i.documentId, d.id))
    .where(and(eq(c.id, id), eq(c.importId, importId)));
  return row ?? null;
}
export async function questionRegionPreview(
  importId: string,
  id: string,
  meta: NonNullable<Awaited<ReturnType<typeof candidatePreviewMetadata>>>,
) {
  const refs = meta.payload["provenance"];
  if (!Array.isArray(refs) || !refs.length)
    throw Error("missing_question_provenance");
  const ref = refs[0] as {
    page: number;
    bbox: { x: number; y: number; width: number; height: number };
  };
  const key = `questions/imports/${importId}/previews/${id}.png`;
  if (!(await headObject(key))) {
    const bytes = new Uint8Array(await getBytes(meta.objectKey));
    if (sha256(bytes) !== meta.sha256) throw Error("document_hash_mismatch");
    const geometry = await readPdfPageGeometry(bytes, ref.page);
    const page = {...geometry, items: []};
    const { renderQuestionCrop } = await import("../../questions/pdf");
    await putBytes(
      key,
      Buffer.from(await renderQuestionCrop(bytes, page, ref.bbox, 100)),
      "image/png",
    );
  }
  return { id, url: await presignGet(key), expiresInSec: 3600 };
}

/** CCR118: short durable claims work through transaction-mode poolers. IO never holds a DB transaction. */
let activeManualImages = 0;
export async function withCandidatePageImage<T>(
  importId: string,
  operation: (claim: string) => Promise<T>,
  denied: (message: string) => Promise<T>,
): Promise<T> {
  const { db, questionImports: i } = await dbm();
  if (activeManualImages >= 2) return denied("page_image_capacity");
  activeManualImages++;
  const claim = "manual-page:" + crypto.randomUUID();
  let claimed = false;
  try {
    const failure = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('question-manual-page-capacity'))`,
      );
      const [job] = await tx
        .select()
        .from(i)
        .where(eq(i.id, importId))
        .for("update");
      if (!job || !["review", "completed"].includes(job.status))
        return "import_not_in_review";
      if (job.leaseUntil && job.leaseUntil.getTime() > Date.now())
        return "page_image_in_progress";
      const [capacity] = await tx
        .select({ n: count() })
        .from(i)
        .where(
          sql`${i.workerId} LIKE 'manual-page:%' AND ${i.leaseUntil}>now()`,
        );
      if (Number(capacity?.n ?? 0) >= 2) return "page_image_capacity";
      await tx
        .update(i)
        .set({ workerId: claim, leaseUntil: new Date(Date.now() + 180000) })
        .where(eq(i.id, importId));
      return null;
    });
    if (failure) return denied(failure);
    claimed = true;
    return await operation(claim);
  } finally {
    if (claimed)
      await db
        .update(i)
        .set({ workerId: null, leaseUntil: null })
        .where(and(eq(i.id, importId), eq(i.workerId, claim)));
    activeManualImages--;
  }
}
export async function cleanupCandidatePageImage(
  importId: string,
  id: string,
  key: string,
  claim: string,
) {
  const { db, questionImports: i, questionImportCandidates: c } = await dbm();
  if (!key.startsWith(`questions/imports/${importId}/crops/manual-${id}-`))
    return;
  const mayDelete = await db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(i)
      .where(eq(i.id, importId))
      .for("update");
    if (
      job?.workerId !== claim ||
      !job.leaseUntil ||
      job.leaseUntil.getTime() <= Date.now()
    )
      return false;
    const [candidate] = await tx
      .select()
      .from(c)
      .where(and(eq(c.id, id), eq(c.importId, importId)));
    const refs = candidate?.payload["imageRefs"];
    if (
      Array.isArray(refs) &&
      refs.some(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          (r as { objectKey?: unknown }).objectKey === key,
      )
    )
      return false;
    await tx
      .update(i)
      .set({ leaseUntil: new Date(Date.now() + 180000) })
      .where(eq(i.id, importId));
    return true;
  });
  if (mayDelete) {
    const { pageImageIo } =
      await import("../../questions/imports/manual-page-image");
    await pageImageIo((signal) => deleteObject(key, signal));
  }
}
export async function candidatePageImageMetadata(
  importId: string,
  id: string,
  page: number,
  revision: number,
  tx?: Tx,
  importRevision = 0,
) {
  const {
    db,
    questionImportCandidates: c,
    questionImports: i,
    questionDocuments: d,
    questionSourcesCatalog: s,
    examPapers: p,
    questionBank: q,
  } = await dbm();
  const connection = tx ?? db;
  if (tx) {
    const graph = await recoveryState(tx, importId, importRevision);
    if (!graph.ok) return graph;
  }
  const [meta] = await connection
    .select({
      candidate: c,
      job: i,
      document: d,
      source: s,
      paper: p,
      question: q,
    })
    .from(c)
    .innerJoin(i, eq(c.importId, i.id))
    .innerJoin(d, eq(i.documentId, d.id))
    .innerJoin(s, eq(i.sourceId, s.id))
    .leftJoin(p, eq(i.paperId, p.id))
    .leftJoin(q, eq(c.questionId, q.id))
    .where(and(eq(c.id, id), eq(c.importId, importId)));
  if (!meta) return err("not_found", "candidate not found");
  if (isContextManaged(meta.candidate.payload) && (!Array.isArray(meta.candidate.payload.ownProvenance) || !Array.isArray(meta.candidate.payload.ownImageRefs)))
    return err('validation', 'context_baselines_missing_staging_review');
  if (meta.job.revision !== importRevision) return err("conflict", "import_revision_changed");
  if (meta.candidate.revision !== revision)
    return err("conflict", "candidate_revision_changed");
  if (
    !["review", "completed"].includes(meta.job.status) ||
    !new Set<string>([PARSER_VERSION, "f33-layout-v1", "f33-layout-v2", "f33-layout-v3", "f33-layout-v4", "f33-layout-v5", "f33-layout-v6"]).has(
      meta.job.parserVersion,
    )
  )
    return err("conflict", "import_not_in_review");
  if (
    meta.question?.publishedAt ||
    meta.question?.catalogStatus === "published" ||
    (meta.paper && ["published", "withdrawn"].includes(meta.paper.status))
  )
    return err("conflict", "published_requires_new_version");
  if (
    meta.document.kind !== "exam" ||
    meta.document.sourceId !== meta.source.id ||
    meta.job.documentId !== meta.document.id
  )
    return err("validation", "page_image_not_exam_document");
  if (
    ["restricted", "revoked"].includes(meta.source.rightsStatus) ||
    (meta.source.rightsExpiresAt &&
      meta.source.rightsExpiresAt.getTime() <= Date.now())
  )
    return err("conflict", "source_rights_unavailable");
  if (
    meta.document.pages === null ||
    page > meta.document.pages ||
    meta.job.excludedPages.includes(page) ||
    !meta.candidate.provenance.some(
      (ref) => ref.documentId === meta.document.id && ref.page === page,
    )
  )
    return err("validation", "page_not_in_candidate_provenance");
  const refs = meta.candidate.payload["imageRefs"];
  if (
    Array.isArray(refs) &&
    refs.length >= 10 &&
    !refs.some(
      (ref) =>
        typeof ref === "object" &&
        ref !== null &&
        (ref as { page?: unknown; method?: unknown }).page === page &&
        (ref as { method?: unknown }).method === "manual_page",
    )
  )
    return err("validation", "page_image_limit");
  return ok(meta);
}
export async function appendCandidatePageImage(
  tx: Tx,
  importId: string,
  id: string,
  revision: number,
  claim: string,
  prepared: import("../../questions/imports/manual-page-image").PreparedPageImage,
  importRevision = 0,
) {
  const metadata = await candidatePageImageMetadata(
    importId,
    id,
    prepared.page,
    revision,
    tx,
    importRevision,
  );
  if (!metadata.ok) return metadata;
  const meta = metadata.data;
  if (
    meta.job.workerId !== claim ||
    !meta.job.leaseUntil ||
    meta.job.leaseUntil.getTime() <= Date.now()
  )
    return err("conflict", "page_image_claim_lost");
  if (
    meta.document.id !== prepared.documentId ||
    meta.document.sha256 !== prepared.documentHash
  )
    return err("conflict", "page_image_document_changed");
  const refs = Array.isArray(meta.candidate.payload["imageRefs"])
    ? meta.candidate.payload["imageRefs"]
    : [];
  if (
    refs.some(
      (raw) =>
        typeof raw === "object" &&
        raw !== null &&
        (raw as { objectKey?: unknown }).objectKey === prepared.objectKey,
    )
  )
    return ok({
      candidate: meta.candidate,
      questionId: meta.candidate.questionId,
      importRevision: meta.job.revision,
      affectedCandidates: [],
    });
  const { questionImportCandidates: c, questionBank: q } = await dbm();
  // Private evidence is not a clinical asset. Only later explicit review with an alt text can include it.
  const payload = {
    ...meta.candidate.payload,
    imageRefs: [
      ...refs,
      {
        page: prepared.page,
        bbox: {
          x: 0,
          y: 0,
          width: (prepared.width * 72) / 100,
          height: (prepared.height * 72) / 100,
        },
        method: "manual_page",
        objectKey: prepared.objectKey,
        sha256: prepared.sha256,
        bytes: prepared.bytes,
        provenance: {
          documentId: prepared.documentId,
          page: prepared.page,
          bbox: [0, 0, 1, 1],
        },
      },
    ],
    imagesConfirmed: false,
    integrityConfirmed: false,
  };
  const priorOwnRefs = Array.isArray(meta.candidate.payload.ownImageRefs) ? meta.candidate.payload.ownImageRefs : refs;
  const payloadWithBases = { ...payload, ownImageRefs: [...priorOwnRefs, payload.imageRefs.at(-1)!] };
  const issues = [
    ...new Set([...meta.candidate.issues, "manual_page_image_requires_review"]),
  ];
  const [candidate] = await tx
    .update(c)
    .set({ payload: payloadWithBases, issues, state: "needs_review", revision: revision + 1 })
    .where(eq(c.id, id))
    .returning();
  if (meta.question)
    await tx
      .update(q)
      .set({
        integrityConfirmed: false,
        catalogStatus: "draft",
        status: "draft",
        reviewedHash: null,
        reviewerName: null,
        reviewerCrm: null,
        referenceDate: null,
      })
      .where(eq(q.id, meta.question.id));
  const { questionImports: imports } = await dbm();
  await tx.update(imports).set({revision:meta.job.revision+1,updatedAt:new Date()}).where(eq(imports.id,importId));
  return ok({ candidate: candidate!, questionId: candidate!.questionId, importRevision:meta.job.revision+1,affectedCandidates:[] });
}

// CCR130 recovery helpers are owned by the coordinated backend-deep lane.
import { recoveryState, frozenRecovery, bumpImport, effectiveStem, orderDraftOccurrences, lockAssociatedQuestionGraphs, lockPublicationQuestionGraph } from './recovery';
