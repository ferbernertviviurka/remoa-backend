// F17 sharing (D-281, D-285–D-291): link access, password unlock and "Copiar para os meus mapas".
import { z } from 'zod';
import { areas } from './enums';
import { idSchema, timestampSchema } from './common';
import { boardAccessSchema, edgeSchema, refineSharePassword, sharePasswordSchema } from './board';
import { cardCaseSchema, cardConceptSchema, cardFlowSchema, cardImageSchema, cardNoteSchema } from './card';

/** 32 random bytes, base64url without padding. Also validates the `/m/:token` path param before any query. */
export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const SHARE_LIMITS = {
  /** FR-14: a correct password unlocks for 12 h in that browser. */
  accessTtlSeconds: 12 * 3600,
  /** FR-14: 5 wrong passwords per IP and link in 15 min block for 15 min. */
  unlockAttempts: 5,
  unlockWindowMinutes: 15,
  /** GET /v1/public/shared/:token per IP. */
  viewsPerMinute: 60,
} as const;
/** The web app keeps the access grant in an httpOnly cookie scoped to `/m/<token>` and forwards it to the API in this header. */
export const SHARE_ACCESS_COOKIE = 'remoa_share';
export const SHARE_ACCESS_HEADER = 'x-remoa-share-access';

/** PUT /v1/boards/:id/share. `password` with access=password sets or changes it (omitted = keep the current one); `rotate` issues a new token. */
export const updateShareInputSchema = z
  .object({ access: boardAccessSchema, password: sharePasswordSchema.optional(), rotate: z.boolean().optional() })
  .superRefine(refineSharePassword({ requirePassword: false }))
  .refine((v) => !(v.rotate && v.access === 'owner'), { path: ['rotate'], message: 'rotate needs a link' });
export type UpdateShareInput = z.infer<typeof updateShareInputSchema>;

/** GET/PUT /v1/boards/:id/share (owner only). The password is never returned, not even as a hash. */
export const shareStateSchema = z.object({
  access: boardAccessSchema,
  url: z.string().url().nullable(),
  /** FR-20: how many copies were made from the link. */
  copies: z.number().int().nonnegative(),
});
export type ShareState = z.infer<typeof shareStateSchema>;

/** POST /v1/public/shared/:token/unlock. Any length up to the max is accepted so a short guess is just "Senha incorreta". */
export const unlockInputSchema = z.object({ password: z.string().min(1).max(64) });
export type UnlockInput = z.infer<typeof unlockInputSchema>;
/** What the API hands the web app after a correct password; the value is opaque (signed, carries share_secret_version). */
export type SharedAccessGrant = { value: string; expiresAt: Date };

/** POST /v1/boards/copy (auth). Private boards also need the access grant in SHARE_ACCESS_HEADER. */
export const copyBoardInputSchema = z.object({ token: shareTokenSchema });
export type CopyBoardInput = z.infer<typeof copyBoardInputSchema>;

// --- Public read model ---------------------------------------------------------
// Allowlist: build responses with `sharedBoardSchema.parse(...)` so unknown keys are stripped. Never FSRS state, tags,
// status/reviewer (no "revisado" seal, rule 6), rubric, owner id, e-mail, token, hash or R2 key.
const sharedCardOmit = { boardId: true, tags: true, status: true, reviewerId: true, rubric: true, updatedAt: true, preview: true } as const;
/** Card as the read-only canvas renders it: typed payload (steps, case stages, masks) with asset ids resolved in `assets`. */
export const sharedCardSchema = z.discriminatedUnion('type', [
  cardConceptSchema.omit(sharedCardOmit),
  cardFlowSchema.omit(sharedCardOmit),
  cardImageSchema.omit(sharedCardOmit),
  cardCaseSchema.omit(sharedCardOmit),
  cardNoteSchema.omit(sharedCardOmit),
]);
export type SharedCard = z.infer<typeof sharedCardSchema>;
export const sharedEdgeSchema = edgeSchema.omit({ boardId: true });
export type SharedEdge = z.infer<typeof sharedEdgeSchema>;
/** Short-lived signed URLs (same variants as AssetView), keyed by asset id in `SharedBoard.assets`. */
export const sharedAssetSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  attribution: z.string().nullable(),
  urls: z.object({ w800: z.string().url(), w1600: z.string().url() }),
});
export type SharedAsset = z.infer<typeof sharedAssetSchema>;

export const sharedBoardSchema = z.object({
  locked: z.literal(false),
  access: z.enum(['password', 'public']),
  title: z.string().min(1),
  area: z.enum(areas),
  /** FR-13: names of the linked items (code + title only). */
  matrixItems: z.array(z.object({ code: z.string().min(1), title: z.string().min(1) })),
  cards: z.array(sharedCardSchema),
  edges: z.array(sharedEdgeSchema),
  assets: z.record(idSchema, sharedAssetSchema),
  cardCount: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
  /** FR-13: set only when the request carries the owner's session, so the page can redirect to the editor; else null. */
  ownBoardId: idSchema.nullable().default(null),
});
export type SharedBoard = z.infer<typeof sharedBoardSchema>;
/** FR-14: private board without a valid grant. Nothing else, not even the title. */
export const sharedLockedSchema = z.object({ locked: z.literal(true) }).strict();
export type SharedLocked = z.infer<typeof sharedLockedSchema>;
/** GET /v1/public/shared/:token: unknown, rotated, owner-only and archived tokens are all a plain 404 not_found. */
export const sharedBoardResponseSchema = z.discriminatedUnion('locked', [sharedBoardSchema, sharedLockedSchema]);
export type SharedBoardResponse = z.infer<typeof sharedBoardResponseSchema>;
