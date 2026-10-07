// F31 (G23, CCR-080, D-1456–D-1465): "Mapas prontos do ENAMED". Two shapes:
//  - file format (`docs/content/enamed/<slug>/mapa.yaml`, evidencias.jsonl, verificacao.json, dossier decisions), keys in pt-BR
//    as authors write them (GUIA-DE-ESCRITA §4);
//  - what lands in the DB and on Card/Board output: `cards.didactics`, `cards.sources`, `cards.path_order`, `card_prereqs`,
//    `boards.path`, `boards.badges`.
// Shape checks live here; graph (order, cycles), targets, distribution, `porQue` per level, sources present and literal copy are
// `content:lint` (T1), because the template itself is a partial example.
import { z } from 'zod';
import { assetLicenses, type Area, type CardType } from './enums';
import type { CaseStage } from './card';

// --- Enums ---------------------------------------------------------------------
export const pathModules = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'] as const;
export type PathModule = (typeof pathModules)[number];
/** 1 = reconhecer, 2 = aplicar, 3 = decidir (FR-4). */
export const pathLevels = [1, 2, 3] as const;
/** D-1458: pt-BR as in the guide and the template; `dose` needs double check (FR-27). */
export const cardRisks = ['nenhum', 'conduta', 'dose'] as const;
export type CardRisk = (typeof cardRisks)[number];
export const maceteTypes = ['sigla', 'rima', 'analogia', 'imagem'] as const;
/** FR-5: named connections. File-only (lint and build label); not stored on `edges` (D-1462). */
export const connectionTypes = ['leva_a', 'pre_requisito', 'diferencia_de', 'trata_com', 'complica', 'contraindica', 'confunde_com'] as const;
export type ConnectionType = (typeof connectionTypes)[number];
export const verifyVerdicts = ['sustenta', 'parcial', 'contradiz'] as const;
export const contentReviewDecisions = ['aprovo', 'ajustar', 'rejeitar'] as const;
/** D-1461: board seals shown in the library; server-owned, only on seed boards (DB check). */
export const boardBadges = ['top10_enamed'] as const;
export type BoardBadge = (typeof boardBadges)[number];

export const cardFileTypes = ['conceito', 'fluxograma', 'imagem', 'caso'] as const;
export type CardFileType = (typeof cardFileTypes)[number];
export const cardFileTypeToCardType = { conceito: 'concept', fluxograma: 'flow', imagem: 'image', caso: 'case' } as const satisfies Record<CardFileType, CardType>;
export const caseFileStages = ['apresentacao', 'exames', 'diagnostico', 'conduta'] as const;
export const caseFileStageToCaseStage = {
  apresentacao: 'presentation', exames: 'workup', diagnostico: 'diagnosis', conduta: 'management',
} as const satisfies Record<(typeof caseFileStages)[number], CaseStage>;

/** Matriz de Referência do ENAMED (Portaria Inep 478/2025): 7 areas, and the board `area` each one is filed under. */
export const enamedAreaToArea = {
  'Clínica Médica': 'CM',
  Cirurgia: 'CIR',
  'Ginecologia e Obstetrícia': 'GO',
  Pediatria: 'PED',
  'Medicina de Família e Comunidade': 'MP',
  'Saúde Coletiva': 'MP',
  'Saúde Mental': 'CM',
} as const satisfies Record<string, Area>;
export type EnamedArea = keyof typeof enamedAreaToArea;
const enamedAreaSchema = z.enum(Object.keys(enamedAreaToArea) as [EnamedArea, ...EnamedArea[]]);

// --- Limits (FR-7, FR-21, FR-23, guide §4–5) ----------------------------------------
export const CONTENT_LIMITS = {
  frontChars: 180,
  backWords: 40,
  listItems: 6,
  whyWords: 50,
  maceteWords: 8,
  evidenceWords: 25,
  /** content:lint flags this many consecutive words copied from the evidence. */
  literalCopyWords: 12,
  flowSteps: { min: 2, max: 12 },
} as const;
export const CONTENT_DISCLAIMER = 'Conteúdo educacional. Não substitui diretriz clínica nem supervisão.';
/** Lines that start like a list item (`-`, `*`, `•`, `1.`, `1)`). */
/** Same rule as blog's countWords (not imported: blog → admin → board → content would be a cycle). */
export const countContentWords = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
export const countListItems = (s: string) => s.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s/.test(l)).length;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'AAAA-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');
const text = (max = 2000) => z.string().trim().min(1).max(max);
const maxWords = (n: number) => (s: string) => countContentWords(s) <= n;

// --- Pieces shared by file and DB -------------------------------------------------
export const maceteSchema = z.object({
  tipo: z.enum(maceteTypes),
  texto: text(200),
  /** FR-14/FR-19: what each part means. Required. */
  explicacao: text(600),
});
export type Macete = z.infer<typeof maceteSchema>;
/** FR-24: what the newest guideline says, with its date. */
export const guidelineNoteSchema = z.object({ texto: text(600), data: isoDate });

/** `cards.sources` item (D-1452, FR-21). `doc` = id in the map's FONTES.md; `acesso` = date read. */
export const cardSourceSchema = z.object({ doc: text(120), local: text(300), versao: text(120), acesso: isoDate });
export type CardSource = z.infer<typeof cardSourceSchema>;

/** `cards.didactics` (D-1457). Study order is NOT here: it is `cards.path_order` (D-1459). */
export const didacticsSchema = z.object({
  nivel: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  modulo: z.enum(pathModules),
  porQue: text(1000).refine(maxWords(CONTENT_LIMITS.whyWords), `até ${CONTENT_LIMITS.whyWords} palavras`).optional(),
  macete: maceteSchema.optional(),
  pegadinha: text(600).optional(),
  naProva: text(600).optional(),
  naDiretriz: guidelineNoteSchema.optional(),
  risco: z.enum(cardRisks),
  /** FR-27: two checkers required (`risco: dose`). */
  revisaoDupla: z.boolean().optional(),
});
export type Didactics = z.infer<typeof didacticsSchema>;

/** `boards.path` (D-1460): set on trail boards (seed and their copies); null on ordinary maps. Time mark is `boards.temporal_mark`. */
export const boardPathSchema = z.object({
  /** Stable key for build idempotency and `/mapas-prontos/[slug]` (unique among non-private boards). */
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80),
  modulos: z.array(z.enum(pathModules)).min(1),
  area: enamedAreaSchema,
  dominios: z.array(text(200)),
  competencias: z.array(text(200)),
  revisarAte: isoDate,
  /** Content version, e.g. "2026.1" (boards.version stays the publish counter). */
  versao: text(40),
  aviso: z.literal(CONTENT_DISCLAIMER),
});
export type BoardPath = z.infer<typeof boardPathSchema>;

// --- File format: mapa.yaml --------------------------------------------------------
const fileCardId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug-m1-001').max(80);
/** The template keeps `AAAA-MM-DD` until the source is read; content:lint rejects it, the build never writes it. */
const fileSourceSchema = cardSourceSchema.extend({ acesso: isoDate.or(z.literal('AAAA-MM-DD')) });
const front = text(CONTENT_LIMITS.frontChars);
const back = text(1000)
  .refine(maxWords(CONTENT_LIMITS.backWords), `até ${CONTENT_LIMITS.backWords} palavras`)
  .refine((s) => countListItems(s) <= CONTENT_LIMITS.listItems, `lista com até ${CONTENT_LIMITS.listItems} itens`);

const cardFileBase = didacticsSchema.extend({
  id: fileCardId,
  ordem: z.number().int().positive(),
  titulo: text(200),
  preRequisitos: z.array(fileCardId).default([]),
  /** Presence is content:lint's job (the template has an empty one). */
  fontes: z.array(fileSourceSchema),
  /** Matriz domain/competence codes and subtopic. */
  tags: z.array(z.string().min(1).max(64)).max(20).default([]),
});
export const cardFileSchema = z.discriminatedUnion('tipo', [
  cardFileBase.extend({ tipo: z.literal('conceito'), frente: front, verso: back }),
  cardFileBase.extend({
    tipo: z.literal('fluxograma'),
    frente: front,
    passos: z
      .array(z.object({ id: z.string().min(1).max(64), texto: text(500) }))
      .min(CONTENT_LIMITS.flowSteps.min)
      .max(CONTENT_LIMITS.flowSteps.max)
      .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, 'duplicate step id'),
  }),
  cardFileBase.extend({
    tipo: z.literal('imagem'),
    frente: front,
    imagem: z
      .object({
        /** Relative to the map folder, e.g. `imagens/sofa.svg`. */
        arquivo: z.string().regex(/^imagens\/[a-z0-9-]+\.(svg|png|jpe?g|webp)$/),
        licenca: z.enum(assetLicenses),
        credito: text(300).optional(),
        alt: text(500),
        mascaras: z.array(z.object({ rotulo: text(120) })).min(1).max(30),
      })
      .refine((i) => i.licenca === 'own' || i.credito !== undefined, { message: 'crédito obrigatório fora de licença própria', path: ['credito'] }),
  }),
  cardFileBase.extend({
    tipo: z.literal('caso'),
    caso: z.object({ apresentacao: text(), exames: text(), diagnostico: text(), conduta: text() }),
  }),
]);
export type CardFile = z.infer<typeof cardFileSchema>;

export const connectionFileSchema = z.object({ de: fileCardId, para: fileCardId, rotulo: text(120), tipo: z.enum(connectionTypes) });
export type ConnectionFile = z.infer<typeof connectionFileSchema>;

const nat = z.number().int().nonnegative();
export const mapFileSchema = z
  .object({
    mapa: z.object({
      slug: boardPathSchema.shape.slug,
      titulo: text(120),
      area: enamedAreaSchema,
      dominios: z.array(text(200)),
      competencias: z.array(text(200)),
      marcoTemporal: text(80),
      revisarAte: isoDate,
      versao: text(40),
      /** FR-28: files never carry an approved status; approval happens in F10 by a reviewer. */
      status: z.literal('seed_draft'),
      aviso: z.literal(CONTENT_DISCLAIMER),
      metas: z.object({ cards: nat, casos: nat, fluxogramas: nat, imagens: nat, macetes: nat, pegadinhas: nat }),
      /** D-1461: e.g. `[top10_enamed]`. */
      selos: z.array(z.enum(boardBadges)).default([]),
    }),
    cards: z.array(cardFileSchema).min(1),
    conexoes: z.array(connectionFileSchema).default([]),
  })
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    m.cards.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cards', i, 'id'], message: `id repetido: ${c.id}` });
      ids.add(c.id);
    });
    m.cards.forEach((c, i) =>
      c.preRequisitos.forEach((p, j) => {
        if (!ids.has(p) || p === c.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cards', i, 'preRequisitos', j], message: `pré-requisito inválido: ${p}` });
      }),
    );
    m.conexoes.forEach((e, i) => {
      for (const k of ['de', 'para'] as const)
        if (!ids.has(e[k])) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['conexoes', i, k], message: `card inexistente: ${e[k]}` });
    });
  });
export type MapFile = z.infer<typeof mapFileSchema>;

// --- evidencias.jsonl, verificacao.json, dossier decisions ---------------------------
/** One line of `evidencias.jsonl` (FR-21): the passage read, at most 25 words. */
export const evidenceSchema = z.object({
  cardId: fileCardId,
  doc: text(120),
  local: text(300),
  trecho: text(400).refine(maxWords(CONTENT_LIMITS.evidenceWords), `até ${CONTENT_LIMITS.evidenceWords} palavras`),
});
export type Evidence = z.infer<typeof evidenceSchema>;
/** content:verify result per card (FR-22). */
export const verifyResultSchema = z.object({ cardId: fileCardId, veredito: z.enum(verifyVerdicts), motivo: text(1000) });
export type VerifyResult = z.infer<typeof verifyResultSchema>;
/** Physician's decision per card in the dossier (FR-26). Named `Content…` because F10's `ReviewDecision` is the editorial-queue input. */
export const contentReviewDecisionSchema = z
  .object({ cardId: fileCardId, decisao: z.enum(contentReviewDecisions), nota: z.string().trim().max(2000).optional() })
  .refine((d) => d.decisao === 'aprovo' || (d.nota?.length ?? 0) > 0, { message: 'nota obrigatória para ajustar ou rejeitar', path: ['nota'] });
export type ContentReviewDecision = z.infer<typeof contentReviewDecisionSchema>;
