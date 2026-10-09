import { createHash } from "node:crypto";
import {
  catalogAlternativesSchema,
  type ImportCandidateReviewInput,
  type QuestionProvenance,
  QUESTION_PDF_PARSER_VERSION,
} from "@remoa/contracts";
import type { PdfLayoutPage, QuestionCandidate } from "../pdf";
export const PARSER_VERSION = QUESTION_PDF_PARSER_VERSION;
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const normalizedText = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();
export function fingerprint(stem: string, alternatives: unknown) {
  const parsed = catalogAlternativesSchema.safeParse(alternatives);
  const content = parsed.success
    ? parsed.data.map((a) => normalizedText(a.text)).sort()
    : alternatives;
  return sha256(JSON.stringify([normalizedText(stem), content]));
}
export function duplicateMatches(
  input: ImportCandidateReviewInput,
  target: {
    stem: string;
    alternatives: unknown;
    correctKey: string | null;
    availability: string;
  },
) {
  const a = catalogAlternativesSchema.safeParse(input.alternatives),
    b = catalogAlternativesSchema.safeParse(target.alternatives);
  if (
    !a.success ||
    !b.success ||
    fingerprint(input.stem, a.data) !== fingerprint(target.stem, b.data)
  )
    return false;
  if (input.annulled !== (target.availability === "annulled")) return false;
  if (input.annulled) return true;
  const first = a.data.find((x) => x.key === input.correctKey),
    second = b.data.find((x) => x.key === target.correctKey);
  return Boolean(
    first &&
    second &&
    normalizedText(first.text) === normalizedText(second.text),
  );
}

/** Diagnostic version only: never rewrite stored hashes/signatures during reads.
 * A legacy asset hash that no longer matches requires an explicit draft edit/new version.
 */
export const QUESTION_CONTENT_HASH_VERSION = "f33-content-v2-jsonb-assets";
function canonicalNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalNested);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalNested(item)]),
    );
  return value;
}
function clinicalAssets(value: unknown): unknown {
  if (!Array.isArray(value)) return canonicalNested(value);
  return value.map((asset: unknown) => {
    if (asset !== null && typeof asset === "object" && !Array.isArray(asset))
      return canonicalNested(
        Object.fromEntries(
          Object.entries(asset).filter(([key]) => key !== "url"),
        ),
      );
    return canonicalNested(asset);
  });
}
export function contentHash(content: {
  stem: string;
  alternatives: unknown;
  correctKey: string | null;
  explanation: string | null;
  areaId: string | null;
  topicId: string | null;
  annulled: boolean;
  assets?: unknown;
}) {
  return sha256(
    JSON.stringify({
      stem: content.stem,
      alternatives: canonicalNested(content.alternatives),
      correctKey: content.correctKey,
      explanation: content.explanation,
      areaId: content.areaId,
      topicId: content.topicId,
      annulled: content.annulled,
      assets: clinicalAssets(content.assets ?? []),
    }),
  );
}
/** Missing legacy field is unmanaged; malformed present bindings fail closed. */
export function isContextManaged(payload: Record<string, unknown>) {
  return payload.contextBindings !== undefined && (!Array.isArray(payload.contextBindings) || payload.contextBindings.length > 0);
}
export function contextStructureChanged(input: ImportCandidateReviewInput, stored: {stem: string; alternatives: unknown; correctKey: string | null; availability: string; assets: unknown}) {
  const fixed = {explanation: null, areaId: null, topicId: null};
  return contentHash({...fixed,stem: input.stem,alternatives: input.alternatives,correctKey: input.annulled ? null : input.correctKey,annulled: input.annulled,assets: input.assets ?? stored.assets}) !==
    contentHash({...fixed,stem: stored.stem,alternatives: stored.alternatives,correctKey: stored.correctKey,annulled: stored.availability === 'annulled',assets: stored.assets});
}
export function normalizedProvenance(
  candidate: Pick<QuestionCandidate, "provenance">,
  pages: PdfLayoutPage[],
  documentId: string,
): QuestionProvenance[] {
  return candidate.provenance.map((p) => {
    const page = pages.find((x) => x.page === p.page);
    if (!page) throw Error("missing_provenance_page");
    return {
      documentId,
      page: p.page,
      bbox: [
        p.bbox.x / page.width,
        p.bbox.y / page.height,
        p.bbox.width / page.width,
        p.bbox.height / page.height,
      ].map((v) => Math.max(0, Math.min(1, v))) as [
        number,
        number,
        number,
        number,
      ],
    };
  });
}
export function assertCandidate(
  input: ImportCandidateReviewInput,
  payload: Record<string, unknown>,
) {
  if (input.state === "accepted" || input.state === "duplicate") {
    if (
      !input.integrityConfirmed ||
      !input.keyFinal ||
      !input.areaId ||
      !input.topicId
    )
      throw Error("integrity_key_taxonomy_required");
    if (
      !input.alternatives ||
      !catalogAlternativesSchema.safeParse(input.alternatives).success
    )
      throw Error("valid_objective_alternatives_required");
    if (!input.annulled && !input.correctKey) throw Error("final_key_required");
    const additional = input as ImportCandidateReviewInput & {
      imagesConfirmed?: boolean;
      assets?: { objectKey: string; alt: string }[];
    };
    if (
      Array.isArray(payload["issues"]) &&
      payload["issues"].includes("figure_geometry_unknown") &&
      !additional.imagesConfirmed
    )
      throw Error("visual_pdf_confirmation_required");
    if (
      Array.isArray(payload["imageRefs"]) &&
      payload["imageRefs"].length &&
      (!additional.imagesConfirmed || !additional.assets?.length)
    )
      throw Error("images_confirmation_required");
  }
}
export interface PublicationGate {
  contentHash: string | null;
  reviewedHash: string | null;
  reviewerName: string | null;
  reviewerCrm: string | null;
  referenceDate: string | null;
  catalogStatus: string;
  status: string;
  rightsStatus: string;
  integrityConfirmed: boolean;
  keyFinal: boolean;
  enamedConfirmed: boolean;
  enamedAreaId: string | null;
  enamedTopicId: string | null;
  explanation: string | null;
  availability: string;
  correctKey: string | null;
  visibility: string;
  userId: string | null;
}
export function assertPublish(
  q: PublicationGate,
  source: { rightsStatus: string; rightsExpiresAt: Date | null },
  lastReview: { decision: string; contentHash: string } | undefined,
  expectedHash: string,
) {
  if (q.visibility !== "public" || q.userId !== null)
    throw Error("institutional_public_only");
  if (q.catalogStatus === "withdrawn")
    throw Error("withdrawn_requires_new_version");
  if (q.contentHash !== expectedHash || q.contentHash !== q.reviewedHash)
    throw Error("content_hash_changed");
  if (
    !lastReview ||
    lastReview.decision !== "approved" ||
    lastReview.contentHash !== q.contentHash ||
    q.status !== "approved"
  )
    throw Error("latest_medical_review_required");
  if (
    source.rightsStatus !== "authorized" ||
    q.rightsStatus !== "authorized" ||
    (source.rightsExpiresAt && source.rightsExpiresAt.getTime() <= Date.now())
  )
    throw Error("source_rights_required");
  if (
    !q.integrityConfirmed ||
    !q.keyFinal ||
    !q.enamedConfirmed ||
    !q.enamedAreaId ||
    !q.enamedTopicId
  )
    throw Error("integrity_key_taxonomy_required");
  if (
    !q.reviewerName?.trim() ||
    !q.reviewerCrm?.trim() ||
    !q.referenceDate ||
    !q.explanation?.trim()
  )
    throw Error("medical_comment_required");
  if (q.availability === "active" && !q.correctKey)
    throw Error("final_key_required");
}
