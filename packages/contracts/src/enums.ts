// Single source for enum values: used by zod schemas here and by pgEnum in @remoa/db.
/** `concept` = "Pergunta e Resposta" na UI (frente/verso); `note` = "Conteúdo", só informativo, fora do FSRS e do desafio (D-200). */
export const cardTypes = ['concept', 'flow', 'image', 'case', 'note'] as const;
/** Card outline on the map (D-095). Flow, image and case cards are always `rect`. */
export const cardShapes = ['rect', 'pill', 'circle', 'diamond', 'hexagon'] as const;
export type CardShape = (typeof cardShapes)[number];
export const mapStates = ['review', 'watch', 'steady', 'unknown'] as const;
export const challengeModes = ['hidden_card', 'edge', 'next_step', 'occlusion', 'case'] as const;
export const grades = ['again', 'hard', 'good', 'easy'] as const; // FSRS 1..4 = index + 1
export const verdicts = ['correct', 'partial', 'incorrect'] as const;
export const inputKinds = ['self', 'mcq', 'text', 'voice'] as const;
export const profileRoles = ['student', 'reviewer', 'admin'] as const;
export const boardStatuses = ['private', 'seed_draft', 'seed_approved'] as const;
export const cardStatuses = ['draft', 'approved'] as const; // UI: rascunho / aprovado
export const assetLicenses = ['own', 'cc_by', 'servier', 'openstax'] as const;
export const sessionKinds = ['daily', 'board'] as const;
export const fsrsCardStates = ['new', 'learning', 'review', 'relearning'] as const;
export const plans = ['free', 'pro', 'founder'] as const;
export const subscriptionStatuses = ['active', 'trialing', 'past_due', 'canceled', 'incomplete'] as const;
export const importKinds = ['anki', 'pdf'] as const;
export const jobStatuses = ['queued', 'running', 'done', 'failed'] as const;
export const editorialStatuses = ['pending', 'approved', 'changes_requested', 'rejected'] as const;
export const flagSources = ['ai', 'user_disagree'] as const;
/**
 * D-280/D-285: the 5 grandes áreas are a board label (Clínica Médica, Cirurgia, GO, Pediatria, Medicina Preventiva).
 * CCR-083 (D-1470): `OUTRO` = "Outro assunto" (non-medical map); never a matrix area, never offered in onboarding.
 */
export const areas = ['CM', 'CIR', 'GO', 'PED', 'MP', 'OUTRO'] as const;
/** Areas with an Enamed matrix, coverage and seeds (MVP: CM only). Lists that mean "the matrix" iterate this, not `areas`. */
export const matrixAreas = ['CM'] as const satisfies readonly Area[];
/**
 * CCR-017 (D-572): every grande área with its availability, in UI order. `available: false` = the web shows "Em breve" and
 * the server refuses it where a user picks an area to study (onboarding). `OUTRO` is left out (D-1470). Names live in @remoa/strings (`boards.area.<id>`).
 */
export const AREA_OPTIONS = areas.filter((id) => id !== 'OUTRO').map((id) => ({ id, available: (matrixAreas as readonly string[]).includes(id) }));
export const isAreaAvailable = (a: Area) => (matrixAreas as readonly string[]).includes(a);
/** D-281/D-285: `owner` = Só eu (no link) · `password` = Privado (link + senha) · `public` = Público (link). */
export const boardAccess = ['owner', 'password', 'public'] as const;

export type CardType = (typeof cardTypes)[number];
export type MapState = (typeof mapStates)[number];
export type ChallengeMode = (typeof challengeModes)[number];
export type Grade = (typeof grades)[number];
export type Verdict = (typeof verdicts)[number];
export type InputKind = (typeof inputKinds)[number];
export type ProfileRole = (typeof profileRoles)[number];
export type BoardStatus = (typeof boardStatuses)[number];
export type CardStatus = (typeof cardStatuses)[number];
export type AssetLicense = (typeof assetLicenses)[number];
export type SessionKind = (typeof sessionKinds)[number];
export type FsrsCardState = (typeof fsrsCardStates)[number];
export type Plan = (typeof plans)[number];
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];
export type ImportKind = (typeof importKinds)[number];
export type JobStatus = (typeof jobStatuses)[number];
export type EditorialStatus = (typeof editorialStatuses)[number];
export type FlagSource = (typeof flagSources)[number];
export type Area = (typeof areas)[number];
export type BoardAccess = (typeof boardAccess)[number];
