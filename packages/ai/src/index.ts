export { feedbackSoFar, GRADER_PROMPT_VERSION, RUBRIC_PROMPT_VERSION, EXTRACT_PROMPT_VERSION } from './openrouter';
export { aiConfig, aiMode, type AiMode, type AiConfig, chainFor, modelFor, missingConfig } from './config';
export { AiError, AI_ERROR_MESSAGES, type AiErrorCode, aiUsage, classify, costCents, generateJson, generateText, parseJsonText, jsonStats, streamText, type Completion } from './client';
export { aiHealth, validateAi, type AiHealth } from './catalog';
export { gradeOffline } from './offline';
export { gradeWithMeta, streamGrade, cachedRubric, rubricFromCard, rubricWithMeta, type GradeEvent } from './grade';
export { chunkText, mergeDrafts, layout, extractOffline, extractWithMeta } from './extract';
export { pdfPageCount, pdfText, readPdfText } from './pdf';
export { cleanDeep, cleanText } from './text';
export { ocrPdf } from './ocr';
export { runOfflineEval } from './eval';
export { graderCases } from './eval-cases';
export { CHALLENGE_PROMPT_IDS, type ChallengePromptId, type ChallengePrompt, lintPrompt, loadChallengePrompt, renderChallengePrompt } from './challenge-prompts';
export { CHALLENGE_TASKS, type ChallengeTask, type ChallengeLimits, challengeChainFor, challengeLimits, challengeModelFor } from './challenge-config';
export {
  type ChallengeVerdict, type Evidence, type Letter, type ModelGrade, type Prefiltered, type PrefilterReason,
  LEAK_FALLBACK_FEEDBACK, LEAK_FALLBACK_HINT, LETTERS, evidenceIsLiteral, finalVerdict, isDuplicateStem, isManipulation, keepDistinctStems,
  leaksAnswer, literalEvidence, numbersGrounded, prefilterAnswer, remapLetters, scrubLeak, shuffleAlternatives, stemSimilarity, ungroundedNumbers,
} from './challenge-guards';
export { readPdfLayout, readPdfPageGeometry, PdfLayoutError, PDF_LAYOUT_LIMITS, type PdfLayoutErrorCode, type PdfLayoutPage, type PdfLayoutItem, type PdfLayoutBox } from './pdf-layout';

export { withCompletionReceipts, ReceiptPersistenceError, type CompletionReceiptCall, type CompletionReceiptHooks } from './receipts';

export { completionFromEnvelope } from './client';
export { captureHttpEnvelope, HTTP_RECEIPT_MAX_BODY_BYTES, type HttpCompletionEnvelope } from './http-envelope';
