/** CCR150 proposal tests: Drizzle metadata and SQL source invariants only. NOT SQL execution/RLS/transaction proof. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getTableConfig, pgTable } from 'drizzle-orm/pg-core';
import { healthProfessionCodes } from '@remoa/contracts';
import { healthCurationQuestionColumns, healthCurationReviewColumns, healthTaxonomy, questionSourceRevisions } from './schema/health-curation';

const proposal = readFileSync(new URL('../../../../docs/content/questions/acquisition-20261013/schema-proposal.sql', import.meta.url), 'utf8');
const legacy = readFileSync(new URL('../migrations/0053_f33_institutional_validation.sql', import.meta.url), 'utf8');
const journal = readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8');
const body = (name: string) => proposal.slice(proposal.indexOf(`FUNCTION public.${name}(`), proposal.indexOf('END $$;', proposal.indexOf(`FUNCTION public.${name}(`)));

describe('G28 external-curation proposal, before0057 integration', () => {
  it('only models new tables; a single existing question chain is retained', () => {
    const names = [...proposal.matchAll(/CREATE TABLE public\.(\w+)/g)].map(m => m[1]);
    expect(names).toEqual(['health_taxonomy', 'question_source_revisions']);
    expect(proposal).not.toMatch(/CREATE TABLE.*(?:question_bank|question_versions)/);
    // 0057 is F35 (study profile, D-1850..D-1860); this proposal is not a migration yet and takes the next free number (0058).
    expect(journal).not.toMatch(/health_curation|external_curation|source_revisions/);
  });
  it('uses the same12 approved professions without replacing ENAMED enums', () => {
    const cfg = getTableConfig(healthTaxonomy);
    expect(cfg.columns.find(c => c.name === 'profession_code')?.enumValues).toEqual([...healthProfessionCodes]);
    for (const code of healthProfessionCodes) expect(proposal).toContain(`'${code}'`);
    expect(proposal).not.toMatch(/ALTER TYPE.*area|UPDATE.*profession_code\s*=/i);
  });
  it('cross-profession parent FK and code/revision uniqueness are represented', () => {
    const cfg = getTableConfig(healthTaxonomy);
    expect(cfg.foreignKeys[0]?.reference().columns.map(c => c.name)).toEqual(['parent_id', 'profession_code']);
    expect(cfg.foreignKeys[0]?.reference().foreignColumns.map(c => c.name)).toEqual(['id', 'profession_code']);
    expect(cfg.uniqueConstraints.map(c => c.name)).toContain('health_taxonomy_code_revision_uq');
    expect(cfg.indexes.map(i => i.config.name)).toContain('health_taxonomy_parent_idx');
    expect(body('f33_health_metadata_guard')).toContain('invalid_health_taxonomy_lineage');
  });
  it('source revisions retain attribution, document/evidence hashes, actor deletion semantics and unique revision', () => {
    const cfg = getTableConfig(questionSourceRevisions);
    expect(cfg.uniqueConstraints.find(c => c.name === 'question_source_revisions_source_revision_uq')?.columns.map(c => c.name)).toEqual(['source_id', 'revision']);
    const actor = cfg.foreignKeys.find(f => f.reference().columns[0]?.name === 'actor_id');
    expect(actor?.onDelete).toBe('set null');
    expect(cfg.columns.find(c => c.name === 'actor_id')?.notNull).toBe(false);
    expect(cfg.indexes.map(i => i.config.name)).toContain('question_source_revisions_actor_idx');
    expect(body('f33_health_metadata_guard')).toContain('source_document_mismatch');
    expect(body('f33_health_metadata_guard')).toContain('external_source_cannot_be_remoa_owned');
  });
  it('every extension is nullable with no inferred legacy default', () => {
    for (const columns of [healthCurationQuestionColumns(), healthCurationReviewColumns()]) {
      const cfg = getTableConfig(pgTable('schema_test_only', columns));
      for (const c of cfg.columns) {
        expect(c.notNull, c.name).toBe(false);
        expect(c.hasDefault, c.name).toBe(false);
      }
    }
    expect(proposal).not.toMatch(/UPDATE public\.question_bank|ADD COLUMN (?:profession_code|language_tag).*DEFAULT/);
  });
  it('preserves legacy publication expression exactly instead of relaxing the old gates', () => {
    const oldExpression = legacy.split('ADD CONSTRAINT "question_bank_publish_chk" CHECK (')[1]!.split(';--> statement-breakpoint')[0]!.slice(0, -1);
    expect(proposal).toContain(oldExpression);
    expect(proposal).toContain("IF NEW.validation_kind=''remoa_curation'' THEN");
    expect(proposal).toContain("IF TG_OP=''INSERT'' AND NEW.kind=''remoa_curation'' THEN");
    expect(proposal).toContain('unexpected_question_guard_baseline');
    expect(proposal).toContain('unexpected_signature_guard_baseline');
  });
  it('new publication requires external origin, null owner/CRM, verified source+PT+integrity and null-safe gates', () => {
    const q = body('f33_curation_validate_question');
    expect(q).toContain("q.origin IN('official_exam','licensed_dataset')");
    expect(q).toContain('q.user_id IS NULL');
    expect(q).toContain("q.language_tag IN('pt','pt-BR','pt-PT')");
    expect(q).toContain('q.integrity_confirmed AND q.profession_verified AND q.language_verified AND q.health_taxonomy_verified');
    expect(q).toContain("s.rights_scope IS DISTINCT FROM 'remoa_owned'");
    expect(q).toContain('s.rights_expires_at>now()');
    expect(q).toContain('IS NOT TRUE');
    expect(q).toContain('v.reviewer_crm IS NULL');
    expect(body('f33_curation_signature_guard')).toContain("p.role='admin' AND p.deleted_at IS NULL AND p.suspended_at IS NULL");
    expect(proposal).not.toMatch(/30 minutes|reauthMinutes/);
  });
  it('does not claim dataset labels are official final keys or allow guessed answer mapping', () => {
    const q = body('f33_curation_validate_question');
    expect(q).toContain("e->>'kind'='official_final' AND e->>'finalityVerified'='true' AND q.key_final");
    expect(q).toContain("e->>'kind'='dataset_label' AND e->>'labelVerified'='true'");
    expect(q).toContain('q.key_final=false');
    expect(q).toContain("e->>'mappingValidated'='true'");
    expect(q).toContain('official_key_document_mismatch');
    expect(q).toContain('dataset_document_mismatch');
    expect(q).toContain("'__proto__','prototype','constructor'");
  });
  it('rejects unresolved context/PII and exposes no consent checkbox grant', () => {
    const q = body('f33_curation_validate_question');
    expect(q).toContain("q.curation_personal_data_status IS DISTINCT FROM 'not_detected'");
    expect(q).toContain("ctx.status='unresolved'");
    expect(q).toContain('cardinality(c.issues)>0');
    expect(proposal).not.toContain('consent');
  });
  it('allows null explanation only with explicit absent state; medical explanation claims still need a real review', () => {
    const q = body('f33_curation_validate_question');
    expect(q).toContain("IF q.explanation_status='absent'");
    expect(q).toContain('q.explanation IS NOT NULL');
    expect(q).toContain("v.kind='medical_review' AND v.decision='approved' AND v.content_hash=q.content_hash");
    expect(q).toContain('medical_explanation_review_required');
  });
  it('binds signed scope/evidence and preserves the reviewed snapshot after account deletion', () => {
    const q = body('f33_curation_validate_question');
    expect(q).toContain('q.curation_scope_hash=public.f33_curation_scope_hash(q.curation_scope)');
    expect(q).toContain('v.curation_scope_snapshot=q.curation_scope');
    expect(q).toContain('v.source_revision_id=r.id');
    expect(body('f33_curation_snapshot_immutable')).toContain('curation_signature_immutable');
    expect(proposal).toContain('PostgreSQL jsonb canonical text SHA256');
  });
  it('private evidence has RLS and revoked client permissions, with no answer/snapshot broad grant', () => {
    expect(proposal).toContain('ALTER TABLE public.question_source_revisions ENABLE ROW LEVEL SECURITY');
    expect(proposal).toContain('REVOKE ALL ON public.health_taxonomy,public.question_source_revisions FROM PUBLIC,anon,authenticated');
    const grants = proposal.split('\n').filter(line => /^GRANT .*TO (authenticated|anon)/.test(line));
    for (const grant of grants) {
      expect(grant).not.toMatch(/correct_key|explanation,|curation_scope|snapshot|GRANT SELECT ON/);
      expect(grant).not.toContain('question_source_revisions');
    }
    expect(proposal).toContain("s.rights_status='authorized' AND(s.rights_expires_at IS NULL OR s.rights_expires_at>now())");
    expect(proposal).not.toContain('SECURITY DEFINER');
  });
  it('metadata withdrawal does not silently invalidate a distributed reference; explicit withdrawal is required first', () => {
    expect(body('f33_health_metadata_guard').match(/withdraw_published_questions_first/g)).toHaveLength(2);
    expect(body('f33_curation_snapshot_immutable')).toContain('OLD.published_at IS NOT NULL');
    expect(proposal).toContain('question_bank_source_revision_idx');
    expect(proposal).toContain('question_reviews_source_revision_idx');
  });
  it('base documents and exam proof cannot be rebound after verification or withdrawal; legacy rows stay outside the guard', () => {
    const docReference = proposal.slice(proposal.indexOf('FUNCTION public.f33_curation_document_referenced'), proposal.indexOf('FUNCTION public.f33_curation_exam_referenced'));
    expect(docReference).toContain("r.status IN('verified','withdrawn')");
    expect(docReference).toContain("v.kind='remoa_curation'");
    const guard = body('f33_curation_proof_immutable');
    expect(guard).toContain('IF NOT public.f33_curation_document_referenced(OLD.id)');
    expect(guard).toContain('IF NOT public.f33_curation_exam_referenced(OLD)');
    expect(guard).toContain('NEW.sha256,NEW.bytes,NEW.pages,NEW.mime');
    expect(guard).toContain('NEW.document_id,NEW.answer_key_document_id');
    expect(guard).toContain('curation_document_immutable_create_revision');
    expect(guard).toContain('curation_exam_immutable_create_revision');
    expect(guard.match(/IF TG_OP='DELETE' THEN RAISE/g)).toHaveLength(2);
    expect(guard).not.toContain('NEW.status');
    expect(guard).not.toContain('NEW.duration_sec');
  });
  it('verification locks documents before SHA recheck without late document-to-revision row locks', () => {
    const guard = body('f33_health_metadata_guard');
    expect(guard.indexOf('ORDER BY d.id FOR SHARE')).toBeLessThan(guard.indexOf("FOR doc IN SELECT"));
    const proof = body('f33_curation_proof_immutable');
    expect(proof).not.toMatch(/FOR UPDATE|FOR SHARE|FOR NO KEY UPDATE/);
    expect(proposal).toContain('REVOKE ALL ON FUNCTION public.f33_curation_document_referenced(uuid)');
  });
});
