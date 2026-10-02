// Signatures of the domain functions each lane implements for real.
// `mocks/` implements every one of them; real implementations should `satisfies` these types.
import type { Grade, MapState } from './enums';
import type { Result } from './errors';
import type { Board, BoardGraph, BoardSummary, CreateBoardInput, MapOp, UpdateBoardInput } from './board';
import type { AssetRef, AssetView, CardDetail, CardDraft, Rubric, SaveCardInput, UploadCompleteInput, UploadSignInput, UploadSignOutput } from './card';
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
import type { CheckoutInput, Entitlements, QuotaKey, RedirectUrl } from './billing';
import type { CoverageRow, MatrixItem, MatrixArea } from './matrix';
import type { BoardVersion, PublishVersionInput, ResolveDisputeInput, ReviewDecision, ReviewItem } from './editorial';
import type { ApkgSummary, FieldMapping, ImportPlan, ImportProgress, ImportReport } from './import';
import type { HomeSummary, ProgressSummary } from './reports';
import type { OnboardingAnswers, WaitlistEntry } from './onboarding';

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
export type ToDrafts = (file: Uint8Array, plan: ImportPlan) => Async<CardDraft[]>;
export type GetImportProgress = (userId: string, importId: string) => Async<ImportProgress>;
export type GetImportReport = (userId: string, importId: string) => Async<ImportReport>;

// F07 matrix
export type GetCoverage = (userId: string) => Async<CoverageRow[]>;
/** G01 v2 "Novo mapa": items of an area (public reference data). */
export type ListMatrixItems = (area: MatrixArea) => Async<MatrixItem[]>;
/** G01 v2 "Hoje" (GET /v1/home). */
export type GetHomeSummary = (userId: string, now: Date) => Async<HomeSummary>;

// F08 billing
export type GetEntitlements = (userId: string) => Async<Entitlements>;
/** Fails with `quota_exceeded` when the key is at its limit. */
export type AssertQuota = (userId: string, key: QuotaKey) => Async<null>;
export type CreateCheckout = (userId: string, input: CheckoutInput) => Async<RedirectUrl>;
export type OpenPortal = (userId: string) => Async<RedirectUrl>;
export type ExportAccount = (userId: string) => Async<RedirectUrl>;
export type DeleteAccount = (userId: string) => Async<{ hardDeleteAt: Date }>;

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
