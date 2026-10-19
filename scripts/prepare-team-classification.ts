#!/usr/bin/env node
/** Read-only offline queue preparation. No HTTP client, database, credentials, review approval or catalog mutation. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CORPUS_HASH, MANIFEST_HASH, MEMBERSHIP_HASH, NAMESPACE, hash, parseBatch, pins, project } from '../apps/api/src/admin/questions/team-publication/domain';
import { CLASSIFICATION_RULES, RULE_VERSION, csvCell, suggest } from './team-classification-rules';

const args = process.argv.slice(2);
function option(name: string) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
export async function prepare(packagePath: string, outputPath: string) {
  const pkg = resolve(packagePath), out = resolve(outputPath);
  if (!relative(pkg, out).startsWith('..')) throw Error('output_must_be_outside_immutable_package');
  if (hash(await readFile(resolve(pkg, 'MANIFESTO.json'))) !== MANIFEST_HASH) throw Error('manifest_changed');
  const wrappers = [];
  for (const [index, pin] of pins.batches.entries()) {
    const path = resolve(pkg, pin.arquivo);
    if (relative(pkg, path).startsWith('..')) throw Error('unsafe_pin_path');
    wrappers.push(...parseBatch(index + 1, await readFile(path, 'utf8')));
  }
  if (wrappers.length !== 28188 || new Set(wrappers.map(row => row.offlineId)).size !== 28188) throw Error('membership_count_mismatch');
  const membership = wrappers.map(row => `${row.offlineId}\t${row.payloadSha256}\n`).sort().join('');
  if (hash(membership) !== MEMBERSHIP_HASH) throw Error('membership_hash_mismatch');
  const ruleHash = hash(JSON.stringify({ version: RULE_VERSION, rules: CLASSIFICATION_RULES }));
  const byCourse: Record<string, Record<string, number>> = {};
  const rows = wrappers.map(wrapper => {
    const q = project(wrapper);
    const draft = suggest(q.profession, q.stem);
    const counts = byCourse[q.profession] ??= { total: 0, areaSuggested: 0, topicSuggested: 0, abstained: 0, conflict: 0 };
    counts.total!++;
    if (draft.outcome === 'suggested') { counts.areaSuggested!++; counts.topicSuggested!++; } else counts[draft.outcome]!++;
    return {
      schemaVersion: 1, namespace: NAMESPACE, corpusHash: CORPUS_HASH, membershipHash: MEMBERSHIP_HASH,
      questionId: q.questionId, offlineId: wrapper.offlineId, contentHash: q.contentHash,
      payloadSha256: wrapper.payloadSha256, sourceLineSha256: wrapper.sourceLineSha256,
      sourceId: q.sourceId, source: { name: q.sourceName, url: q.sourceUrl, year: wrapper.payload.ano, edition: wrapper.payload.edicao, originalNumber: wrapper.payload.numero },
      course: q.profession, sourceAreaTags: Array.isArray(wrapper.payload.areas) ? wrapper.payload.areas : [],
      availability: q.availability, resolutionEligible: q.availability === 'active',
      stem: q.stem, alternatives: q.alternatives,
      taxonomySystem: 'proposed_remoa_course_taxonomy', taxonomyReviewed: false,
      ruleVersion: RULE_VERSION, ruleHash, confidence: 'heuristic_not_calibrated',
      reviewStatus: 'pending_review', proposedDifficulty: null,
      ...draft,
      review: { decision: null, reviewer: null, reviewedAt: null, area: null, topic: null, notes: null },
    };
  });
  // Refuse an existing review folder: a rerun must never erase the team's filled decision columns.
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  await mkdir(resolve(out, 'por-curso'), { recursive: true });
  const jsonl = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(resolve(out, 'fila-classificacao.jsonl'), jsonl);
  const headers = ['questionId', 'offlineId', 'contentHash', 'payloadSha256', 'curso', 'aptaResolucao', 'statusRevisao', 'statusSugestao', 'areaSugerida', 'assuntoSugerido', 'evidenciaLiteral', 'regra', 'versaoRegras', 'fonte', 'urlFonte', 'numeroOriginal', 'enunciado', 'alternativas', 'decisaoRevisor', 'nomeRevisor', 'dataRevisao', 'areaCorrigida', 'assuntoCorrigido', 'observacoesRevisor'];
  function csvRow(row: typeof rows[number]) {
    const proposed = row.suggestion;
    return [row.questionId, row.offlineId, row.contentHash, row.payloadSha256, row.course, row.resolutionEligible ? 'sim' : 'nao', row.reviewStatus, row.outcome, proposed?.proposedArea, proposed?.proposedTopic, proposed?.evidence.map(e => e.text).join(' | '), proposed?.ruleId, row.ruleVersion, row.source.name, row.source.url, row.source.originalNumber, row.stem, row.alternatives.map(a => `${a.key}: ${a.text}`).join('\n'), '', '', '', '', '', ''].map(csvCell).join(',');
  }
  const csv = (records: typeof rows) => '\uFEFF' + [headers.map(csvCell).join(','), ...records.map(csvRow)].join('\r\n') + '\r\n';
  await writeFile(resolve(out, 'revisao-todas.csv'), csv(rows));
  for (const course of Object.keys(byCourse)) await writeFile(resolve(out, 'por-curso', `${course}.csv`), csv(rows.filter(row => row.course === course)));
  await writeFile(resolve(out, 'regras.json'), JSON.stringify({ version: RULE_VERSION, ruleHash, taxonomyStatus: 'proposed_pending_review', rules: CLASSIFICATION_RULES }, null, 2) + '\n');
  const totals = Object.values(byCourse).reduce((a, row) => { for (const [key, count] of Object.entries(row)) a[key] = (a[key] ?? 0) + count; return a; }, {} as Record<string, number>);
  const receipt = { schemaVersion: 1, namespace: NAMESPACE, corpusHash: CORPUS_HASH, manifestHash: MANIFEST_HASH, membershipHash: MEMBERSHIP_HASH, questionCount: rows.length, allPendingReview: true, catalogWrites: 0, humanApprovals: 0, ruleVersion: RULE_VERSION, ruleHash, queueSha256: createHash('sha256').update(jsonl).digest('hex'), totals, byCourse };
  await writeFile(resolve(out, 'RESUMO.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(resolve(out, 'LEIA-ME.md'), `# Fila de classificação sugerida — revisão do time Remoa\n\n${rows.length.toLocaleString('pt-BR')} questões do lote publicado, com ID e hash do conteúdo original. Todas estão pendentes de revisão. Este pacote não altera a produção e não torna as sugestões disponíveis nos filtros do aluno.\n\n## Como revisar\n\n1. Abra o CSV do seu curso em por-curso. O CSV geral contém todo o corpus. Arquivos em UTF-8 com BOM; no Excel selecione o delimitador vírgula se necessário.\n2. Leia enunciado, alternativas e fonte original. Confira a evidência literal que motivou a regra. O gabarito e a explicação não são exportados.\n3. Preencha decisaoRevisor com aprovar_sugestao, corrigir, rejeitar ou requer_especialista. Identifique nomeRevisor e dataRevisao em ISO 8601. Nas correções, preencha areaCorrigida e assuntoCorrigido; registre a justificativa em observacoesRevisor.\n4. Em abstained ou conflict, a revisão é manual. Não trate ausência de sugestão como ausência de conteúdo. O JSONL preserva até cinco candidatas nos conflitos.\n5. Entregue o CSV revisado preservando questionId, offlineId, contentHash e payloadSha256. Alterações no conteúdo ou hash tornam a classificação obsoleta e exigem nova conferência.\n\n## Limites das sugestões\n\nAs regras locais versão ${RULE_VERSION} exigem pelo menos dois padrões distintos no enunciado, com trechos e posições literais. As alternativas não são usadas para inferir classificação. Os padrões são indícios de busca, não diagnóstico ou confirmação do assunto principal. Negação, diagnósticos diferenciais, siglas e contexto clínico podem produzir falsos positivos. Empates entre assuntos resultam em conflict. Sem sinais suficientes resulta em abstained. Não há probabilidade de acerto calculada nem promessa de cobertura clínica completa.\n\nÁreas e assuntos são uma taxonomia proposta por curso, ainda não revisada. Não são IDs ENAMED nem equivalências automáticas com a matriz. Tags de origem continuam separadas e não revisadas. Dificuldade não foi sugerida. Anuladas e indisponíveis permanecem na fila com aptaResolucao=nao; revisá-las não as torna aptas.\n\n## Publicação posterior\n\nA aprovação no CSV é insumo humano, não uma publicação automática. Aplicação futura exige validar identidade, decisão, vínculo ID/hash e nós da taxonomia revisada; persistir uma revisão auditada em overlay separado do conteúdo assinado; atualizar consultas de área/assunto e testar o criador. Nenhum importador de decisões ou atualização direta de question_bank está incluído nesta preparação.\n\nRESUMO.json contém contagens e hashes; regras.json conserva os padrões e sua versão. fila-classificacao.jsonl preserva contexto, candidatas, evidências, fonte e binding imutável. Prefixos de fórmula nas células CSV são escapados; o JSONL mantém o texto original.\n`);
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pkg = option('--package'), out = option('--output');
  if (!pkg || !out) throw Error('usage: --package PATH --output PATH');
  prepare(pkg, out).then(receipt => console.log(JSON.stringify(receipt))).catch(error => { console.error(error instanceof Error ? error.message : 'preparation_failed'); process.exitCode = 1; });
}
