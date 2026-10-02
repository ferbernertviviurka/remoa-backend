// Mock data only. Medical content is generic, conservative, without doses, and `draft` (never published).
import type { Board, Edge } from '../board';
import type { CardDetail, Rubric } from '../card';
import type { QueueItem, RetrievabilityMap } from '../review';
import type { GraderVerdict } from '../ai';
import type { StartImportInput } from '../import';
import { sharedCardSchema, sharedEdgeSchema, type ShareState, type SharedBoard, type SharedLocked } from '../share';

/** Deterministic valid v4-shaped uuid: fid(1) = 00000000-0000-4000-8000-000000000001. */
export const fid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export const FIXTURE_NOW = new Date('2026-10-01T12:00:00.000Z');
export const fixtureUserId = fid(1);
export const sepseBoardId = fid(100);

export const sepseBoard: Board = {
  id: sepseBoardId,
  userId: fixtureUserId,
  title: 'Sepse',
  area: 'CM',
  matrixItemId: null,
  status: 'seed_draft',
  version: 1,
  temporalMark: 'Enamed 2026.2',
  reviewerId: null,
  sourceBoardId: null,
  archivedAt: null,
  access: 'owner',
  shareUrl: null,
  copiedFrom: null,
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

const SOURCE = 'Sepsis-3 (Singer et al., JAMA 2016); Surviving Sepsis Campaign 2021';
const base = (n: number, x: number, y: number) => ({
  id: fid(n),
  boardId: sepseBoardId,
  source: SOURCE,
  position: { x, y },
  status: 'draft' as const,
  order: n - 200,
  reviewerId: null,
  updatedAt: FIXTURE_NOW,
});

export const sepseRubric: Rubric = {
  points: [
    { text: 'Disfunção orgânica com risco de vida', essential: true },
    { text: 'Causada por resposta desregulada do hospedeiro à infecção', essential: true },
  ],
  source: SOURCE,
  version: 1,
  status: 'draft',
  reviewerId: null,
};

export const sepseCardIds = {
  sepse: fid(201),
  qsofa: fid(202),
  lactato: fid(203),
  pacote: fid(204),
  choque: fid(205),
  caso: fid(206),
} as const;

export const sepseCards: CardDetail[] = [
  {
    ...base(201, 400, 200),
    type: 'concept',
    title: 'Sepse',
    front: 'Qual a definição atual de sepse?',
    shape: 'rect',
    frontAssetId: null,
    backAssetId: null,
    size: null,
    tags: [],
    back: 'Disfunção orgânica com risco de vida causada por resposta desregulada do hospedeiro à infecção.',
    payload: {},
    rubric: sepseRubric,
  },
  {
    ...base(202, 100, 80),
    type: 'concept',
    title: 'qSOFA',
    front: 'Quais critérios compõem o qSOFA?',
    shape: 'rect',
    frontAssetId: null,
    backAssetId: null,
    size: null,
    tags: [],
    back: 'Frequência respiratória aumentada, alteração do estado mental e pressão sistólica baixa. Triagem, não diagnóstico.',
    payload: {},
    rubric: null,
  },
  {
    ...base(203, 100, 320),
    type: 'concept',
    title: 'Lactato',
    front: 'Para que serve o lactato na suspeita de sepse?',
    shape: 'rect',
    frontAssetId: null,
    backAssetId: null,
    size: null,
    tags: [],
    back: 'Marcador de hipoperfusão tecidual; dosar na suspeita e repetir se elevado.',
    payload: {},
    rubric: null,
  },
  {
    ...base(204, 700, 80),
    type: 'flow',
    title: 'Pacote da primeira hora',
    front: null,
    shape: 'rect',
    frontAssetId: null,
    backAssetId: null,
    size: null,
    tags: [],
    back: null,
    payload: {
      steps: [
        { id: 'step-1', text: 'Dosar lactato' },
        { id: 'step-2', text: 'Colher hemoculturas antes do antimicrobiano' },
        { id: 'step-3', text: 'Iniciar antimicrobiano de amplo espectro' },
        { id: 'step-4', text: 'Reposição volêmica se hipotensão ou hipoperfusão', note: 'Volume conforme protocolo institucional' },
        { id: 'step-5', text: 'Vasopressor se hipotensão persistente' },
      ],
    },
    rubric: null,
  },
  {
    ...base(205, 700, 320),
    type: 'concept',
    title: 'Choque séptico',
    front: 'O que caracteriza o choque séptico?',
    shape: 'rect',
    frontAssetId: null,
    backAssetId: null,
    size: null,
    tags: [],
    back: 'Sepse com necessidade de vasopressor para manter a pressão arterial média e lactato elevado apesar de volume adequado.',
    payload: {},
    rubric: null,
  },
  {
    ...base(206, 400, 460),
    type: 'case',
    title: 'Idoso febril e confuso',
    front: null,
    shape: 'rect',
    frontAssetId: null,
    backAssetId: null,
    size: null,
    tags: [],
    back: null,
    payload: {
      caseSteps: [
        { stage: 'presentation', text: 'Idoso com febre, confusão aguda e taquipneia há um dia.' },
        { stage: 'workup', text: 'Hipotensão, lactato elevado, sinais de infecção urinária.' },
        { stage: 'diagnosis', text: 'Sepse de foco urinário.' },
        { stage: 'management', text: 'Pacote da primeira hora e reavaliação seriada.' },
      ],
    },
    rubric: null,
  },
];

const edge = (n: number, from: string, to: string, label: string): Edge => ({
  id: fid(n),
  boardId: sepseBoardId,
  fromCardId: from,
  toCardId: to,
  label,
  question: null,
});
const c = sepseCardIds;
export const sepseEdges: Edge[] = [
  edge(301, c.qsofa, c.sepse, 'triagem para'),
  edge(302, c.lactato, c.sepse, 'estratifica gravidade de'),
  edge(303, c.sepse, c.choque, 'pode evoluir para'),
  edge(304, c.sepse, c.pacote, 'conduta inicial'),
  edge(305, c.pacote, c.lactato, 'começa por dosar'),
  edge(306, c.caso, c.sepse, 'exemplo de'),
];

/** "Revisar hoje" fixture: due by recall asc, then new, then weak. */
export const reviewQueueFixture: QueueItem[] = [
  { boardId: sepseBoardId, cardId: c.pacote, subId: 'step-5', reason: 'due', mode: 'next_step' },
  { boardId: sepseBoardId, cardId: c.choque, reason: 'due', mode: 'edge' },
  { boardId: sepseBoardId, cardId: c.sepse, reason: 'due', mode: 'hidden_card' },
  { boardId: sepseBoardId, cardId: c.qsofa, reason: 'due', mode: 'hidden_card' },
  { boardId: sepseBoardId, cardId: c.caso, reason: 'new', mode: 'case' },
  { boardId: sepseBoardId, cardId: c.lactato, reason: 'new', mode: 'hidden_card' },
  { boardId: sepseBoardId, cardId: c.pacote, subId: 'step-2', reason: 'weak', mode: 'next_step' },
];

export const graderVerdictFixture: GraderVerdict = {
  verdict: 'partial',
  matched: ['Disfunção orgânica com risco de vida'],
  missing: ['Causada por resposta desregulada do hospedeiro à infecção'],
  criticalError: false,
  feedback: 'Você citou a disfunção orgânica, mas faltou dizer que ela decorre da resposta desregulada à infecção.',
  model: 'mock-grader',
};

/** Map colours as in the board mockup: 6 cards, every state represented. */
export const retrievabilityFixture: RetrievabilityMap = {
  [c.sepse]: { r: 0.62, state: 'review' },
  [c.qsofa]: { r: 0.78, state: 'watch' },
  [c.lactato]: { r: 0, state: 'unknown' },
  [c.pacote]: {
    r: 0.74,
    state: 'watch',
    subs: { // step 5 weak (F02 FR-2)
      'step-1': { r: 0.93, state: 'steady' },
      'step-2': { r: 0.88, state: 'steady' },
      'step-3': { r: 0.86, state: 'steady' },
      'step-4': { r: 0.8, state: 'watch' },
      'step-5': { r: 0.52, state: 'review' },
    },
  },
  [c.choque]: { r: 0.55, state: 'review' },
  [c.caso]: { r: 0.91, state: 'steady' },
};

// --- F17 sharing / import v2 ----------------------------------------------------
/** Deterministic 43-char base64url token (the real one is 32 random bytes). */
export const mockShareToken = (n: number) => n.toString().padStart(43, 'A');
export const MOCK_APP_URL = 'https://app.remoa.mock';
export const sharedBoardToken = mockShareToken(1);

/** "Sepse" shared as Público, as the owner sees it. */
export const sharedSepseBoard: Board = {
  ...sepseBoard,
  status: 'private',
  temporalMark: null,
  access: 'public',
  shareUrl: `${MOCK_APP_URL}/m/${sharedBoardToken}`,
};

export const shareStateFixture: ShareState = { access: 'public', url: `${MOCK_APP_URL}/m/${sharedBoardToken}`, copies: 2 };

/** GET /v1/public/shared/:token for a public board: content only, no FSRS, tags, status, rubric or owner data. */
export const sharedBoardFixture: SharedBoard = {
  locked: false,
  access: 'public',
  title: 'Sepse',
  area: 'CM',
  matrixItems: [{ code: 'CM-INF-01', title: 'Sepse e choque séptico' }],
  cards: sepseCards.map((card) => sharedCardSchema.parse(card)), // parse = allowlist (unknown keys stripped)
  edges: sepseEdges.map((e) => sharedEdgeSchema.parse(e)),
  assets: {},
  cardCount: sepseCards.length,
  updatedAt: FIXTURE_NOW,
  ownBoardId: null,
};
export const sharedLockedFixture: SharedLocked = { locked: true };

/** POST /v1/imports/anki with the F17 "Sobre o mapa" block. */
export const startImportInputFixture: StartImportInput = {
  key: `imports/${fixtureUserId}/${fid(701)}.apkg`,
  plan: { deckIds: ['1'], mappings: [{ noteTypeId: '10', cardType: 'concept', title: null, front: 'Front', back: 'Back' }], estimatedCards: 2 },
  board: { title: 'Clínica Médica', area: 'CM', matrixItemIds: [fid(800)], access: 'password', password: 'turma-2026', target: 'new' },
};
