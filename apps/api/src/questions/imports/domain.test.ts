import { describe, it, expect } from "vitest";
import { importCandidateReviewInputSchema } from "@remoa/contracts";
import {
  assertCandidate,
  assertPublish,
  contentHash,
  isContextManaged,
  contextStructureChanged,
  normalizedProvenance,
  duplicateMatches,
  fingerprint,
  type PublicationGate,
} from "./domain";
import { parseExam } from "../pdf";
const input = () =>
  importCandidateReviewInputSchema.parse({
    stem: "Caso sintético",
    alternatives: [
      { key: "A", text: "Primeiro" },
      { key: "B", text: "Segundo" },
    ],
    correctKey: "A",
    explanation: "Comentário sintético",
    areaId: "00000000-0000-4000-8000-000000000001",
    topicId: "00000000-0000-4000-8000-000000000002",
    annulled: false,
    duplicateOf: null,
    state: "accepted",
    revision: 1,
    integrityConfirmed: true,
    keyFinal: true,
    reason: "Conferência sintética",
  });
const q: PublicationGate = {
  contentHash: "hash",
  reviewedHash: "hash",
  reviewerName: "Revisor",
  reviewerCrm: "CRM-PR 1234",
  referenceDate: "2026-10-08",
  catalogStatus: "approved",
  status: "approved",
  rightsStatus: "authorized",
  integrityConfirmed: true,
  keyFinal: true,
  enamedConfirmed: true,
  enamedAreaId: "area",
  enamedTopicId: "topic",
  explanation: "Comentário",
  availability: "active",
  correctKey: "A",
  visibility: "public",
  userId: null,
};
describe("editorial gates", () => {
  it("requires visual PDF confirmation when geometry is unknown without visual keywords", () => {
    const page = {
      page: 1,
      width: 600,
      height: 800,
      items: ["1", "Caso sintético", "(A) Primeiro", "(B) Segundo"].map(
        (text, i) => ({ text, x: 10, y: 50 + i * 20, width: 200, height: 12 }),
      ),
    };
    const candidate = parseExam([page]).candidates[0]!;
    expect(candidate.imageRefs).toEqual([]);
    expect(candidate.issues).toContain("figure_geometry_unknown");
    expect(() =>
      assertCandidate(input(), candidate as unknown as Record<string, unknown>),
    ).toThrow("visual_pdf_confirmation_required");
    expect(() =>
      assertCandidate(
        { ...input(), imagesConfirmed: true },
        candidate as unknown as Record<string, unknown>,
      ),
    ).not.toThrow();
  });
  it("requires assets for known/dependent figures", () => {
    expect(() =>
      assertCandidate(
        { ...input(), imagesConfirmed: true },
        { imageRefs: [{}] },
      ),
    ).toThrow("images_confirmation_required");
  });
  it("requires final key and taxonomy and structural integrity", () => {
    for (const change of [
      { keyFinal: false },
      { integrityConfirmed: false },
      { areaId: null },
      { correctKey: null },
    ])
      expect(() => assertCandidate({ ...input(), ...change }, {})).toThrow();
  });
  it("latest rejection invalidates any historical approval", () => {
    expect(() =>
      assertPublish(
        q,
        { rightsStatus: "authorized", rightsExpiresAt: null },
        { decision: "rejected", contentHash: "hash" },
        "hash",
      ),
    ).toThrow("latest_medical_review_required");
    expect(() =>
      assertPublish(
        q,
        { rightsStatus: "authorized", rightsExpiresAt: null },
        { decision: "approved", contentHash: "hash" },
        "hash",
      ),
    ).not.toThrow();
  });
  it("revoked or expired source blocks publishing", () => {
    for (const source of [
      { rightsStatus: "revoked", rightsExpiresAt: null },
      { rightsStatus: "authorized", rightsExpiresAt: new Date(0) },
    ])
      expect(() =>
        assertPublish(
          q,
          source,
          { decision: "approved", contentHash: "hash" },
          "hash",
        ),
      ).toThrow("source_rights_required");
  });
  it("private owners and stale content hashes never publish", () => {
    expect(() =>
      assertPublish(
        { ...q, userId: "owner" },
        { rightsStatus: "authorized", rightsExpiresAt: null },
        { decision: "approved", contentHash: "hash" },
        "hash",
      ),
    ).toThrow("institutional_public_only");
    expect(() =>
      assertPublish(
        q,
        { rightsStatus: "authorized", rightsExpiresAt: null },
        { decision: "approved", contentHash: "hash" },
        "other",
      ),
    ).toThrow("content_hash_changed");
  });
  it("hash is deterministic and material edit changes review identity", () => {
    const content = {
      stem: "S",
      alternatives: [],
      correctKey: null,
      explanation: null,
      areaId: null,
      topicId: null,
      annulled: false,
    };
    expect(contentHash(content)).toBe(contentHash({ ...content }));
    expect(contentHash(content)).not.toBe(
      contentHash({ ...content, annulled: true }),
    );
  });
  it("normalizes pixel coordinates and rejects missing referenced pages", () => {
    const candidate = parseExam([
      {
        page: 1,
        width: 100,
        height: 200,
        items: [
          { text: "1", x: 0, y: 0, width: 10, height: 10 },
          { text: "texto", x: 10, y: 20, width: 30, height: 10 },
          { text: "(A) a", x: 10, y: 40, width: 30, height: 10 },
          { text: "(B) b", x: 10, y: 60, width: 30, height: 10 },
        ],
      },
    ]).candidates[0]!;
    expect(
      normalizedProvenance(
        candidate,
        [{ page: 1, width: 100, height: 200, items: [] }],
        "doc",
      )[0]?.bbox?.every((v) => v >= 0 && v <= 1),
    ).toBe(true);
    expect(() => normalizedProvenance(candidate, [], "doc")).toThrow(
      "missing_provenance_page",
    );
  });
  it("deduplicates reordered alternatives only when semantic final answer and annulment agree", () => {
    const accepted = input();
    const target = {
      stem: accepted.stem,
      alternatives: [
        { key: "A", text: "Segundo" },
        { key: "B", text: "Primeiro" },
      ],
      correctKey: "B",
      availability: "active",
    };
    expect(duplicateMatches(accepted, target)).toBe(true);
    expect(duplicateMatches(accepted, { ...target, correctKey: "A" })).toBe(
      false,
    );
    expect(
      duplicateMatches(accepted, { ...target, availability: "annulled" }),
    ).toBe(false);
    expect(
      duplicateMatches(
        { ...accepted, annulled: true },
        { ...target, availability: "annulled" },
      ),
    ).toBe(true);
    expect(duplicateMatches(accepted, { ...target, alternatives: null })).toBe(
      false,
    );
    expect(duplicateMatches({ ...accepted, correctKey: null }, target)).toBe(
      false,
    );
    expect(
      duplicateMatches(accepted, { ...target, stem: "Outra negação ou dose" }),
    ).toBe(false);
    expect(fingerprint("Dose 5 mg", accepted.alternatives)).not.toBe(
      fingerprint("Dose 50 mg", accepted.alternatives),
    );
    expect(fingerprint("Caso", null)).toBe(fingerprint("Caso", null));
  });
});


describe('context-managed draft structural guard',()=>{
 const stored=()=>({stem:input().stem,alternatives:input().alternatives,correctKey:input().correctKey,availability:'active',assets:[]});
 it.each([{stem:'Não trocar 2 kg.'},{alternatives:[{key:'A' as const,text:'Alterado'},{key:'B' as const,text:'Segundo'}]},{correctKey:'B' as const},{annulled:true}])('requires staging for structural change %j',patch=>{expect(contextStructureChanged({...input(),...patch},stored())).toBe(true)});
 it('permits commentary and taxonomy changes while keeping immutable shared structure',()=>{expect(contextStructureChanged({...input(),explanation:'Comentário novo',areaId:null,topicId:null},stored())).toBe(false)});
 it('excludes volatile asset URLs but protects alt/provenance/order',()=>{
  const asset={id:'00000000-0000-4000-8000-000000000003',objectKey:'questions/imports/x/crops/image.png',alt:'Descrição',provenance:{documentId:'00000000-0000-4000-8000-000000000004',page:1,bbox:[0,0,1,1] as [number,number,number,number]}};
  expect(contextStructureChanged({...input(),assets:[asset]},{...stored(),assets:[{...asset,url:'https://example.org/expired'}]})).toBe(false);
  expect(contextStructureChanged({...input(),assets:[{...asset,alt:'Descrição alterada'}]},{...stored(),assets:[asset]})).toBe(true);
 });
 it.each([{}, {contextBindings:[]}])('does not treat absent/empty bindings as managed %j',payload=>expect(isContextManaged(payload)).toBe(false));
 it.each([{contextBindings:null},{contextBindings:'invalid'},{contextBindings:[{contextId:'bad'}]}])('fails closed for malformed/present bindings %j',payload=>expect(isContextManaged(payload)).toBe(true));
});
