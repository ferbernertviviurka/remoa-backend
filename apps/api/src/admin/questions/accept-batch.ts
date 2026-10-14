// D-1841: "Aceitar selecionadas" — the single-candidate accept (updateCandidate, state accepted) applied to many candidates of one
// import, each in its own savepoint, inside withAdmin's single transaction (one audit row). Never publishes: accepted = draft in_review.
import {
  err, ok, importCandidateReviewInputSchema, questionCandidatePayloadSchema,
  type QuestionCandidateAcceptInput, type QuestionCandidateAcceptOutcome, type Result,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import type { AuditCapture } from '../core';
import { recoveryState, frozenRecovery } from './recovery';
import { updateCandidate } from './service';

class ItemRollback extends Error { constructor(readonly outcome: QuestionCandidateAcceptOutcome, readonly code: string) { super(code); } }
type ItemResult = { id: string; outcome: QuestionCandidateAcceptOutcome; questionId: string | null };

export async function acceptCandidates(tx: Tx, importId: string, input: QuestionCandidateAcceptInput, audit: AuditCapture): Promise<Result<{ results: ItemResult[]; importRevision: number }>> {
  const state = await recoveryState(tx, importId, input.importRevision);
  if (!state.ok) return state;
  if (frozenRecovery(state.data)) return err('conflict', 'published_requires_new_version');
  if (state.data.contexts.some((c) => c.status === 'unresolved')) return err('validation', 'shared_context_resolution_required');
  let revision = input.importRevision;
  const results: ItemResult[] = [], log: (ItemResult & { code: string | null })[] = [];
  // ponytail: updateCandidate reloads the whole import graph per item (O(n²) rows); fine for ≤200, batch the graph if imports grow.
  for (const item of input.items) {
    try {
      const saved = await tx.transaction(async (sp) => {
        const skip = (outcome: QuestionCandidateAcceptOutcome, code: string = outcome): never => { throw new ItemRollback(outcome, code); };
        const row = state.data.candidates.find((c) => c.id === item.id);
        if (!row) return skip('not_found');
        if (row.state === 'accepted') return skip('already_accepted');
        if (!['pending', 'needs_review'].includes(row.state)) return skip('not_pending');
        if (row.revision !== item.revision) return skip('conflict', 'candidate_revision_changed');
        if (row.issues.length) return skip('has_issues');
        const parsed = questionCandidatePayloadSchema.safeParse(row.payload);
        if (!parsed.success) return skip('invalid', 'payload_invalid');
        const p = parsed.data;
        if (!p.areaId || !p.topicId) return skip('taxonomy_missing');
        if (!p.annulled && (!p.correctKey || !p.alternatives?.some((a) => a.key === p.correctKey))) return skip('answer_key_missing');
        if (p.imageRefs.some((ref) => !p.assets.some((a) => a.objectKey === ref.objectKey && a.alt.trim()))) return skip('needs_images');
        const review = importCandidateReviewInputSchema.safeParse({
          stem: p.stem, ownStem: p.ownStem, alternatives: p.alternatives, correctKey: p.correctKey, explanation: p.explanation,
          areaId: p.areaId, topicId: p.topicId, annulled: p.annulled, assets: p.assets.length ? p.assets : undefined,
          // The batch attestation (confirmsChecks) stands in for the three per-item checkboxes.
          keyFinal: true, integrityConfirmed: true, imagesConfirmed: true,
          state: 'accepted', duplicateOf: null, revision: item.revision, importRevision: revision, reason: input.reason,
        });
        if (!review.success) return skip('invalid', review.error.issues[0]?.message ?? 'invalid_candidate');
        const r = await updateCandidate(sp, importId, item.id, review.data);
        if (!r.ok) return skip(r.error.code === 'conflict' ? 'conflict' : 'invalid', r.error.message);
        // Require the actual bumped revision even with the typed service result;
        // never synthesize it or lose the next item's CAS.
        if (!('importRevision' in r.data) || typeof r.data.importRevision !== 'number'
          || !Number.isSafeInteger(r.data.importRevision) || r.data.importRevision !== revision + 1)
          return skip('conflict', 'import_revision_changed');
        return { questionId: r.data.questionId, importRevision: r.data.importRevision };
      });
      revision = saved.importRevision;
      results.push({ id: item.id, outcome: 'accepted', questionId: saved.questionId });
      log.push({ ...results.at(-1)!, code: null });
    } catch (e) {
      if (!(e instanceof ItemRollback)) throw e;
      results.push({ id: item.id, outcome: e.outcome, questionId: null });
      log.push({ ...results.at(-1)!, code: e.code });
    }
  }
  audit.after({ importRevision: revision, confirmsChecks: true, results: log });
  return ok({ results, importRevision: revision });
}
