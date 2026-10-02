// Signatures of the domain functions each lane implements for real.
// `mocks/` implements every one of them; real implementations should `satisfies` these types.
import type { Grade, MapState } from './enums';
import type { Result } from './errors';
import type { Board, BoardGraph, BoardSummary, CreateBoardInput, MapOp, UpdateBoardInput } from './board';
import type { AssetRef, AssetView, CardDetail, Rubric, SaveCardInput, UploadCompleteInput, UploadSignInput, UploadSignOutput } from './card';
import type { Attempt, FsrsMemory, IntervalPreview, QueueItem, RecordAttemptOutput, RetrievabilityMap } from './review';
import type {
  AnswerInput,
  AnswerOutput,
  ItemRef,
  RateInput,
  SessionSummary,
  StartSessionInput,
  StartSessionOutput,
} from './challenge';
import type { BoardGenerationProgress, GenerateBoardInput, GraderInput, GraderVerdict } from './ai';
import type {
  AccountExport,
  CheckoutInput,
  CheckoutSessionStatus,
  CouponInput,
  CouponValidation,
  Entitlements,
  PortalInput,
  PriceBook,
  QuotaKey,
  RedirectUrl,
  SubscriptionSummary,
  SwitchToAnnualResult,
} from './billing';
import type { BoardMatrixLink, CoverageRow, MatrixItem, MatrixArea } from './matrix';
import type { BoardVersion, PublishVersionInput, ResolveDisputeInput, ReviewDecision, ReviewItem } from './editorial';
import type { AnkiDraft, ApkgSummary, ExistingBoard, FieldMapping, ImportPlan, ImportProgress, ImportReport, ImportKeyInput, ImportUploadSignInput, StartImportInput } from './import';
import type { CopyBoardInput, ShareState, SharedAccessGrant, SharedBoardResponse, UnlockInput, UpdateShareInput } from './share';
import type { HomeSummary, ProgressSummary } from './reports';
import type { OnboardingAnswers, WaitlistEntry } from './onboarding';
import type {
  AccountSnapshot,
  AvatarVariants,
  ChangePasswordInput,
  ConfirmAvatarInput,
  LinkedIdentity,
  Preferences,
  Profile,
  RequestEmailChangeInput,
  SessionInfo,
  UpdatePreferencesInput,
  UpdateProfileInput,
} from './account';

type Async<T> = Promise<Result<T>>;

// F01 board (apps/web features/map)
export type ListBoards = (userId: string) => Async<BoardSummary[]>;
export type GetBoard = (userId: string, boardId: string) => Async<BoardGraph>;
export type CreateBoard = (userId: string, input: CreateBoardInput) => Async<Board>;
export type UpdateBoard = (userId: string, boardId: string, input: UpdateBoardInput) => Async<Board>;
/** Copies cards (fresh ids, same positions) and edges; title gets the caller's suffix. */
export type DuplicateBoard = (userId: string, boardId: string, title: string) => Async<Board>;
/** Idempotent by opId; returns the opIds applied (already-seen ops count as applied). */
export type ApplyMapOps = (userId: string, ops: MapOp[]) => Async<{ applied: string[] }>;

// F02 cards
export type GetCard = (userId: string, cardId: string) => Async<CardDetail>;
/** Owner only; image payloads must point at an asset the user can read. */
export type SaveCard = (userId: string, cardId: string, input: SaveCardInput) => Async<CardDetail>;
export type SignUpload = (userId: string, input: UploadSignInput) => Async<UploadSignOutput>;
export type CompleteUpload = (userId: string, input: UploadCompleteInput) => Async<AssetRef>;
export type GetAsset = (userId: string, assetId: string) => Async<AssetView>;

// F03 packages/fsrs — pure and synchronous. `null` memory = card never reviewed.
export type Schedule = (memory: FsrsMemory | null, grade: Grade, now: Date) => FsrsMemory;
export type Preview = (memory: FsrsMemory | null, now: Date) => IntervalPreview;
export type Retrievability = (memory: FsrsMemory | null, now: Date) => number;
export type MapStateOf = (memory: FsrsMemory | null, now: Date) => MapState;
export type VerdictToGrade = (
  verdict: Pick<GraderVerdict, 'verdict' | 'criticalError'>,
  timing: { durationMs: number; medianMs: number | null },
) => Grade;
// F03 server
export type RecordAttempt = (attempt: Attempt) => Async<RecordAttemptOutput>;
export type GetDailyQueue = (userId: string, opts: { now: Date; limit?: number }) => Async<QueueItem[]>;
export type GetBoardQueue = (userId: string, boardId: string, opts: { now: Date; limit?: number }) => Async<QueueItem[]>;
export type GetRetrievability = (userId: string, boardId: string, now: Date) => Async<RetrievabilityMap>;

// F04 challenge
export type StartSession = (userId: string, input: StartSessionInput) => Async<StartSessionOutput>;
export type Answer = (userId: string, input: AnswerInput) => Async<AnswerOutput>;
export type Rate = (userId: string, input: RateInput) => Async<{ due: Date }>;
export type Dispute = (userId: string, input: ItemRef) => Async<{ reviewItemId: string }>;
export type Skip = (userId: string, input: ItemRef) => Async<{ remaining: number }>;
export type FinishSession = (userId: string, sessionId: string) => Async<SessionSummary>;

// F05 packages/ai
export type GradeAnswer = (input: GraderInput) => Async<GraderVerdict>;
export type GenerateRubric = (card: CardDetail, source: string) => Async<Rubric>;
export type GenerateBoard = (userId: string, input: GenerateBoardInput) => Async<{ jobId: string }>;
export type GetGenerationProgress = (userId: string, jobId: string) => Async<BoardGenerationProgress>;

// F06 packages/anki (+ job)
export type Inspect = (file: Uint8Array) => Async<ApkgSummary>;
export type PlanImport = (summary: ApkgSummary, mappings: FieldMapping[], deckIds: string[]) => Result<ImportPlan>;
/** Needs the file again: plans are plain data, the parsed sqlite is not kept. */
export type ToDrafts = (file: Uint8Array, plan: ImportPlan) => Async<AnkiDraft[]>;
/** F06 HTTP flow (D-115). */
export type SignImportUpload = (userId: string, input: ImportUploadSignInput) => Async<UploadSignOutput>;
export type InspectImport = (userId: string, input: ImportKeyInput) => Async<ApkgSummary>;
export type StartImport = (userId: string, input: StartImportInput) => Async<{ importId: string }>;
export type GetImportProgress = (userId: string, importId: string) => Async<ImportProgress>;
export type GetImportReport = (userId: string, importId: string) => Async<ImportReport>;
/** F17 FR-11: GET /v1/imports/anki/existing?title= */
export type FindExistingBoard = (userId: string, title: string) => Async<ExistingBoard>;

// F17 sharing. Share state is written only by the server connection after an ownership check (D-288).
/** GET /v1/boards/:id/share — owner only, else not_found. */
export type GetShare = (userId: string, boardId: string) => Async<ShareState>;
/** PUT /v1/boards/:id/share — every change bumps share_secret_version; `validation` when entering `password` without one. */
export type UpdateShare = (userId: string, boardId: string, input: UpdateShareInput) => Async<ShareState>;
/**
 * GET /v1/public/shared/:token (no auth). `grant` = SHARE_ACCESS_HEADER value; `viewerId` = optional session (owner → ownBoardId).
 * not_found for unknown/rotated/owner-only/archived tokens, without telling which.
 */
export type GetSharedBoard = (token: string, ctx: { grant: string | null; viewerId: string | null }) => Async<SharedBoardResponse>;
/** POST /v1/public/shared/:token/unlock — `unauthorized` (generic) on a wrong password; `rate_limited` after SHARE_LIMITS.unlockAttempts. */
export type UnlockShared = (token: string, input: UnlockInput, ctx: { ip: string }) => Async<SharedAccessGrant>;
/** POST /v1/boards/copy — FR-15: fresh assets/R2 objects, access owner, FSRS from zero; `quota_exceeded` creates nothing. */
export type CopySharedBoard = (userId: string, input: CopyBoardInput, ctx: { grant: string | null }) => Async<Board>;

// F07 matrix
export type GetCoverage = (userId: string) => Async<CoverageRow[]>;
/** G01 v2 "Novo mapa": items of an area (public reference data). */
export type ListMatrixItems = (area: MatrixArea) => Async<MatrixItem[]>;
/** F07 FR-2: up to 3 items by trigram similarity to a board title (GET /v1/matrix/suggest?title=). */
export type SuggestMatrixItems = (title: string) => Async<MatrixItem[]>;
/** F07: link an own board to an item (POST /v1/matrix/links); idempotent; sets boards.matrix_item_id when null. */
export type LinkBoardMatrix = (userId: string, link: BoardMatrixLink) => Async<BoardMatrixLink>;
/** F07: unlink (DELETE /v1/matrix/links); clears boards.matrix_item_id when it pointed at the item. */
export type UnlinkBoardMatrix = (userId: string, link: BoardMatrixLink) => Async<null>;
/** G01 v2 "Hoje" (GET /v1/home). */
export type GetHomeSummary = (userId: string, now: Date) => Async<HomeSummary>;

// F08 billing
export type GetEntitlements = (userId: string) => Async<Entitlements>;
/** Fails with `quota_exceeded` when the key is at its limit. */
export type AssertQuota = (userId: string, key: QuotaKey) => Async<null>;
export type CreateCheckout = (userId: string, input: CheckoutInput) => Async<RedirectUrl>;
export type OpenPortal = (userId: string, input: PortalInput) => Async<RedirectUrl>;
export type ExportAccount = (userId: string) => Async<AccountExport>;
export type DeleteAccount = (userId: string) => Async<{ hardDeleteAt: Date }>;

// F15 planos e checkout. All under /v1/billing (requireUser). POST /checkout and POST /portal are the F08 ones above.
/** GET /v1/billing/prices — Stripe Prices (cached; PRICES_BRL with STRIPE=mock) + nextChargeOn in the user's timezone. */
export type GetPriceBook = (userId: string, now: Date) => Async<PriceBook>;
/** POST /v1/billing/coupon {code} — `{ valid: false }` for any bad code; 429 rate_limited when guessed too often. */
export type ValidateCoupon = (userId: string, input: CouponInput) => Async<CouponValidation>;
/** GET /v1/billing/checkout/:sessionId — `not_found` unless the session's client_reference_id is the caller. */
export type GetCheckoutSession = (userId: string, sessionId: string) => Async<CheckoutSessionStatus>;
/** GET /v1/billing/subscription — null when there is no paid period (Free, never subscribed or lapsed). */
export type GetSubscription = (userId: string) => Async<SubscriptionSummary | null>;
/** POST /v1/billing/switch-annual — `conflict` when not on a monthly Pro period. */
export type SwitchToAnnual = (userId: string) => Async<SwitchToAnnualResult>;

// F10 editorial (reviewerId from session; approveCard/requestChange/rejectCard = decideReviewItem)
export type ListReviewQueue = (reviewerId: string) => Async<ReviewItem[]>;
export type DecideReviewItem = (reviewerId: string, decision: ReviewDecision) => Async<ReviewItem>;
export type ResolveDispute = (reviewerId: string, input: ResolveDisputeInput) => Async<ReviewItem>;
export type PublishVersion = (reviewerId: string, input: PublishVersionInput) => Async<BoardVersion>;
/** Also used by F12 startFromSeed. */
export type CopySeedBoard = (userId: string, seedBoardId: string) => Async<{ boardId: string }>;

// F11 reports
export type GetProgress = (userId: string, now: Date) => Async<ProgressSummary>;

// F12 onboarding
export type JoinWaitlist = (entry: WaitlistEntry) => Async<null>;
export type SaveOnboarding = (userId: string, answers: OnboardingAnswers) => Async<null>;

// F13 account. All under /v1/account (requireUser) except unsubscribe. `sessionId` = JWT `session_id` claim (D-124).
// During scheduled deletion only GET /me, POST /deletion/cancel and POST /export pass; the rest is 403 account_deleted (D-123).
/** GET /v1/account/me */
export type GetAccount = (userId: string) => Async<AccountSnapshot>;
/** PATCH /v1/account/profile */
export type UpdateProfile = (userId: string, input: UpdateProfileInput) => Async<Profile>;
/** POST /v1/account/avatar — after PUT to the URL from POST /v1/uploads/sign {kind:'avatar'}; re-encodes, strips EXIF, deletes the previous object. */
export type ConfirmAvatar = (userId: string, input: ConfirmAvatarInput) => Async<AvatarVariants>;
/** DELETE /v1/account/avatar */
export type RemoveAvatar = (userId: string) => Async<null>;
/** POST /v1/account/email — generic error when the address is taken (never reveals it); 403 during scheduled deletion. */
export type RequestEmailChange = (userId: string, input: RequestEmailChangeInput) => Async<{ pendingEmail: string }>;
/** POST /v1/account/email/resend — 429 rate_limited within ACCOUNT_LIMITS.emailResendSeconds. */
export type ResendEmailChange = (userId: string) => Async<{ pendingEmail: string }>;
/** DELETE /v1/account/email */
export type CancelEmailChange = (userId: string) => Async<null>;
/** POST /v1/account/password — revokes every other session; 429 after ACCOUNT_LIMITS.passwordAttemptsPerHour failures. */
export type ChangePassword = (userId: string, sessionId: string, input: ChangePasswordInput) => Async<{ revokedSessions: number }>;
/** GET /v1/account/sessions */
export type ListSessions = (userId: string, sessionId: string) => Async<SessionInfo[]>;
/** DELETE /v1/account/sessions/:id — the current session is `validation` (use sign out). */
export type RevokeSession = (userId: string, sessionId: string, targetId: string) => Async<null>;
/** DELETE /v1/account/sessions — all but the current one. */
export type RevokeOtherSessions = (userId: string, sessionId: string) => Async<{ count: number }>;
/** DELETE /v1/account/identities/:provider — `conflict` when it is the last sign-in method. Linking Google is client-side OAuth. */
export type UnlinkIdentity = (userId: string, provider: LinkedIdentity['provider']) => Async<LinkedIdentity[]>;
/** PATCH /v1/account/preferences — Free above PLAN_LIMITS.free.newCardsPerDay = `forbidden` 'pro_required' (D-122). */
export type UpdatePreferences = (userId: string, input: UpdatePreferencesInput) => Async<Preferences>;
/** POST /v1/account/deletion/cancel — clears profiles.deleted_at. The Stripe subscription canceled at DELETE stays canceled. */
export type CancelDeletion = (userId: string) => Async<null>;
/** GET /v1/public/unsubscribe?token= (no auth) — turns the daily reminder off. */
export type UnsubscribeReminder = (token: string) => Async<null>;
