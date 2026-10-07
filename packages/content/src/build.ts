// FR-33 `content:build`: mapa.yaml + images -> boards/cards/edges/card_prereqs/assets/masks, always `seed_draft` (FR-28, rule 6).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cardFileTypeToCardType, caseFileStages, caseFileStageToCaseStage, didacticsSchema, enamedAreaToArea, pathModules,
  type CardFile, type ContentReviewDecision, type MapFile, type VerifyResult,
} from '@remoa/contracts';
import type postgres from 'postgres';
import { checkImages, CREDIT_LICENSES, maskPolygons, toWebp, VARIANTS } from './images';
import { hasErrors, lintBundle, type LintOptions } from './lint';
import type { Bundle, Issue } from './load';

/** Same seed reviewer that owns the study-outline seeds (packages/db/src/seed-maps.ts). `CONTENT_OWNER_ID` overrides in the CLI. */
export const SEED_OWNER_ID = '00000000-0000-4000-8000-0000000000f1';

/** Deterministic uuid (v5 layout over sha1) per slug and file id: rebuilding upserts the same rows (D-1474). */
export function stableId(...parts: string[]): string {
  const h = createHash('sha1').update(`remoa-content:${parts.join(':')}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** FR-22 target share of `sustenta`, in %. */
export const MIN_SUSTENTA_PCT = 98;

/**
 * FR-22: reasons the verifier result does not let the map go to review (empty = open). Every card needs a verdict for its current text
 * (the CLI passes `currentVerdicts`, so a stale verdict counts as missing), none `contradiz`, and at least 98% `sustenta`.
 */
export function verifyGate(map: MapFile, verify: VerifyResult[]): string[] {
  const out: string[] = [];
  const verdict = new Map(verify.map((v) => [v.cardId, v.veredito]));
  const contradiz = map.cards.filter((c) => verdict.get(c.id) === 'contradiz').map((c) => c.id);
  const unverified = map.cards.filter((c) => !verdict.has(c.id)).map((c) => c.id);
  const sustenta = map.cards.filter((c) => verdict.get(c.id) === 'sustenta').length;
  if (contradiz.length) out.push(`${contradiz.length} card(s) com contradiz: ${contradiz.join(', ')}`);
  if (unverified.length) out.push(`${unverified.length} card(s) sem verificação`);
  else if (sustenta * 100 < map.cards.length * MIN_SUSTENTA_PCT) out.push(`sustenta ${sustenta} de ${map.cards.length}, abaixo de ${MIN_SUSTENTA_PCT}%`);
  return out;
}

/**
 * FR-28 publication gate: `verifyGate` plus the physician's latest decision `aprovo` for every card (empty = open). The build never
 * publishes even when this is open (D-1475). In the DB the same rule holds by construction (P-672): the build only writes a trail
 * board whose verify gate is open, and F10's publishBoard requires every card approved by the reviewer (the decision, with CRM).
 */
export function publishGate(map: MapFile, verify: VerifyResult[], decisions: ContentReviewDecision[]): string[] {
  const decision = new Map(decisions.map((d) => [d.cardId, d.decisao])); // later lines win
  const unapproved = map.cards.filter((c) => decision.get(c.id) !== 'aprovo').map((c) => c.id);
  return [...verifyGate(map, verify), ...(unapproved.length ? [`${unapproved.length} de ${map.cards.length} card(s) sem "aprovo" do revisor`] : [])];
}

export type Put = (key: string, body: Buffer, contentType: string) => Promise<void>;
export type BuildOptions = LintOptions & {
  ownerId: string;
  /** Uploads the WebP variants (S3/R2); without it only the rows are written (P-671). */
  put?: Put;
  /** Anything but seed_draft is refused (FR-28). */
  status?: 'seed_draft' | 'seed_approved';
  /** Current verdicts (FR-22): a seed_draft is only written with `verifyGate` open (P-672). */
  verify?: VerifyResult[];
  decisions?: ContentReviewDecision[];
};
export type BuildError = { code: 'lint' | 'verify_gate' | 'publish_gate' | 'reviewer_only' | 'published' | 'owner_missing'; message: string; details?: string[] };
export type BuildStats = { boardId: string; created: boolean; cards: number; edges: number; prereqs: number; assets: number; removed: number };
type Result<T> = { ok: true; data: T } | { ok: false; error: BuildError };
const fail = (code: BuildError['code'], message: string, details?: string[]): Result<never> => ({ ok: false, error: { code, message, details } });

type ImageCard = Extract<CardFile, { tipo: 'imagem' }>;
const sourceText = (c: CardFile) => c.fontes.map((f) => `${f.doc}, ${f.local} (${f.versao})`).join('; ');
const fileOf = (c: ImageCard) => c.imagem.arquivo.replace(/^imagens\//, '');

function payloadOf(c: CardFile, slug: string, svgs: Map<string, string>) {
  switch (c.tipo) {
    case 'conceito':
      return {};
    case 'fluxograma':
      return { steps: c.passos.map((p) => ({ id: p.id, text: p.texto })) };
    case 'caso':
      return { caseSteps: caseFileStages.map((s) => ({ stage: caseFileStageToCaseStage[s], text: c.caso[s] })) };
    case 'imagem': {
      const polys = maskPolygons(svgs.get(fileOf(c)) ?? '', c.imagem.mascaras.map((m) => m.rotulo));
      return {
        assetId: stableId(slug, 'asset', fileOf(c)),
        masks: polys.map((m, i) => ({ id: stableId(slug, c.id, 'mask', String(i)), label: m.label, polygon: m.polygon! })),
      };
    }
  }
}

/** Runs inside the caller's transaction (the CLI opens one; tests roll theirs back). Idempotent by `boards.path->>'slug'`. */
export async function buildMap(tx: postgres.TransactionSql, b: Bundle, opts: BuildOptions): Promise<Result<BuildStats>> {
  const issues: Issue[] = [...lintBundle(b, opts), ...checkImages(b)];
  if (!b.map || b.template || hasErrors(issues))
    return fail('lint', b.template ? 'template não é compilado' : 'content:lint/content:images com erros', issues.filter((i) => i.level === 'erro').map((i) => `${i.where}: ${i.message}`));
  const map = b.map;
  const slug = map.mapa.slug;
  if ((opts.status ?? 'seed_draft') !== 'seed_draft') {
    const reasons = publishGate(map, opts.verify ?? [], opts.decisions ?? []);
    if (reasons.length) return fail('publish_gate', 'portão de publicação fechado (FR-28)', reasons);
    return fail('reviewer_only', 'portão aberto, mas só o revisor com CRM publica, pela área editorial (F10, regra 6)');
  }
  // P-672: the DB only gets cards the verifier sustained (FR-146: a map goes to review with lint and verify green).
  const unverified = verifyGate(map, opts.verify ?? []);
  if (unverified.length) return fail('verify_gate', 'content:verify não está verde (FR-22): rode pnpm content:verify', unverified);

  await tx`select pg_advisory_xact_lock(hashtext(${`content:${slug}`}))`;
  const [owner] = await tx`select 1 from auth.users where id = ${opts.ownerId}`;
  if (!owner) return fail('owner_missing', `usuário dono ${opts.ownerId} não existe (rode pnpm db:seed:maps ou defina CONTENT_OWNER_ID)`);
  const [existing] = await tx<{ id: string; status: string }[]>`select id, status from boards where path->>'slug' = ${slug} and status <> 'private' for update`;
  if (existing?.status === 'seed_approved') return fail('published', 'mapa já publicado: atualizar exige nova versão pela área editorial (F10, FR-29)');

  // Images: WebP variants (uploaded when `put` is given) and one assets row per file, same id every build.
  const imageCards = map.cards.filter((c): c is ImageCard => c.tipo === 'imagem');
  const svgs = new Map<string, string>();
  let assets = 0;
  for (const file of new Set(imageCards.map(fileOf))) {
    const bytes = readFileSync(join(b.dir, 'imagens', file));
    if (file.endsWith('.svg')) svgs.set(file, bytes.toString('utf8'));
    const card = imageCards.find((c) => fileOf(c) === file)!;
    const assetId = stableId(slug, 'asset', file);
    const key = `assets/${opts.ownerId}/${assetId}`;
    const webp = await toWebp(bytes, file.endsWith('.svg'));
    if (opts.put) for (const name of Object.keys(VARIANTS) as (keyof typeof VARIANTS)[]) await opts.put(`${key}/${name}.webp`, webp.variants[name], 'image/webp');
    const license = CREDIT_LICENSES[b.credits?.get(file)?.licenca ?? 'original'] ?? card.imagem.licenca;
    await tx`insert into assets (id, user_id, key, mime, width, height, license, attribution)
      values (${assetId}, ${opts.ownerId}, ${key}, 'image/webp', ${webp.width}, ${webp.height}, ${license}::asset_license, ${card.imagem.credito ?? null})
      on conflict (id) do update set key = excluded.key, width = excluded.width, height = excluded.height, license = excluded.license,
        attribution = excluded.attribution, updated_at = now()`;
    assets++;
  }

  const path = {
    slug, modulos: [...pathModules], area: map.mapa.area, dominios: map.mapa.dominios, competencias: map.mapa.competencias,
    revisarAte: map.mapa.revisarAte, versao: map.mapa.versao, aviso: map.mapa.aviso,
  };
  const area = enamedAreaToArea[map.mapa.area];
  let boardId = existing?.id;
  if (boardId)
    await tx`update boards set title = ${map.mapa.titulo}, area = ${area}::area, temporal_mark = ${map.mapa.marcoTemporal}, path = ${tx.json(path)},
      badges = ${map.mapa.selos}::text[], archived_at = null, updated_at = now() where id = ${boardId}`;
  else
    boardId = (await tx<{ id: string }[]>`insert into boards (user_id, title, area, status, temporal_mark, path, badges)
      values (${opts.ownerId}, ${map.mapa.titulo}, ${area}::area, 'seed_draft', ${map.mapa.marcoTemporal}, ${tx.json(path)}, ${map.mapa.selos}::text[])
      returning id`)[0]!.id;

  // Cards: changed content goes back to draft and loses its reviewer (an approval covers the text it saw); the canvas position is
  // only set on insert, so a reviewer's layout survives rebuilds.
  const sorted = [...map.cards].sort((x, y) => x.ordem - y.ordem);
  const row = new Map<string, number>();
  const ids: string[] = [];
  for (const [i, c] of sorted.entries()) {
    const id = stableId(slug, c.id);
    ids.push(id);
    const col = pathModules.indexOf(c.modulo);
    const y = row.get(c.modulo) ?? 0;
    row.set(c.modulo, y + 1);
    const front = c.tipo === 'caso' ? null : c.frente;
    const back = c.tipo === 'conceito' ? c.verso : null;
    const didactics = didacticsSchema.parse(c);
    await tx`insert into cards (id, board_id, type, title, front, back, payload, tags, source, x, y, "order", didactics, sources, path_order)
      values (${id}, ${boardId}, ${cardFileTypeToCardType[c.tipo]}::card_type, ${c.titulo}, ${front}, ${back}, ${tx.json(payloadOf(c, slug, svgs))},
        ${c.tags}::text[], ${sourceText(c)}, ${80 + col * 340}, ${80 + y * 160}, ${i}, ${tx.json(didactics)}, ${tx.json(c.fontes)}, ${c.ordem})
      on conflict (id) do update set
        status = case when (cards.type, cards.title, cards.front, cards.back, cards.payload, cards.tags, cards.source, cards.didactics, cards.sources)
          is distinct from (excluded.type, excluded.title, excluded.front, excluded.back, excluded.payload, excluded.tags, excluded.source, excluded.didactics, excluded.sources)
          then 'draft'::card_status else cards.status end,
        reviewer_id = case when (cards.type, cards.title, cards.front, cards.back, cards.payload, cards.tags, cards.source, cards.didactics, cards.sources)
          is distinct from (excluded.type, excluded.title, excluded.front, excluded.back, excluded.payload, excluded.tags, excluded.source, excluded.didactics, excluded.sources)
          then null else cards.reviewer_id end,
        type = excluded.type, title = excluded.title, front = excluded.front, back = excluded.back, payload = excluded.payload, tags = excluded.tags,
        source = excluded.source, "order" = excluded."order", didactics = excluded.didactics, sources = excluded.sources, path_order = excluded.path_order,
        deleted_at = null, updated_at = now()
      where cards.board_id = excluded.board_id`;
  }
  // A seed_draft is never studied (RLS hides it from students), so cards dropped from the file are deleted, not soft-deleted.
  const removed = (await tx`delete from cards where board_id = ${boardId} and id <> all(${ids}::uuid[]) returning id`).length;

  const masks = sorted.flatMap((c) => {
    if (c.tipo !== 'imagem') return [];
    const p = payloadOf(c, slug, svgs) as { assetId: string; masks: { id: string; label: string; polygon: { x: number; y: number }[] }[] };
    return p.masks.map((m) => ({ ...m, cardId: stableId(slug, c.id), assetId: p.assetId }));
  });
  await tx`delete from masks where card_id = any(${ids}::uuid[]) and id <> all(${masks.map((m) => m.id)}::uuid[])`;
  for (const m of masks)
    await tx`insert into masks (id, card_id, asset_id, polygon, label) values (${m.id}, ${m.cardId}, ${m.assetId}, ${tx.json(m.polygon)}, ${m.label})
      on conflict (id) do update set card_id = excluded.card_id, asset_id = excluded.asset_id, polygon = excluded.polygon, label = excluded.label, updated_at = now()`;

  await tx`delete from card_prereqs where card_id = any(${ids}::uuid[])`;
  let prereqs = 0;
  for (const c of sorted)
    for (const p of c.preRequisitos) {
      await tx`insert into card_prereqs (card_id, prereq_card_id) values (${stableId(slug, c.id)}, ${stableId(slug, p)})`;
      prereqs++;
    }

  const edges = new Map(map.conexoes.map((e) => [stableId(slug, 'edge', e.de, e.para, e.rotulo), e]));
  await tx`delete from edges where board_id = ${boardId} and id <> all(${[...edges.keys()]}::uuid[])`;
  for (const [id, e] of edges)
    await tx`insert into edges (id, board_id, from_card_id, to_card_id, label) values (${id}, ${boardId}, ${stableId(slug, e.de)}, ${stableId(slug, e.para)}, ${e.rotulo})
      on conflict (id) do nothing`;

  // F10 queue: every draft card waits for the physician (one pending row per card).
  await tx`insert into review_queue (card_id, status, flag_source)
    select c.id, 'pending', 'ai' from cards c where c.board_id = ${boardId} and c.status = 'draft' and c.deleted_at is null
      and not exists (select 1 from review_queue q where q.card_id = c.id and q.status = 'pending')`;

  return { ok: true, data: { boardId, created: !existing, cards: ids.length, edges: edges.size, prereqs, assets, removed } };
}
