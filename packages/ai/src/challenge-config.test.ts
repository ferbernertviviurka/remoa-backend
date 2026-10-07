import { describe, expect, it } from 'vitest';
import { challengeChainFor, challengeLimits, challengeModelFor } from './challenge-config';
import { modelFor } from './config';

describe('challengeLimits', () => {
  it('uses the spec defaults when unset or empty', () => {
    const defaults = { sessionTtlMin: 120, maxGradingsPerCardHour: 5, batchGradeMax: 10, genBatchSize: 10, dupThreshold: 0.8, answerMaxChars: 1200 };
    expect(challengeLimits({})).toEqual(defaults);
    expect(challengeLimits({ GEN_DUP_THRESHOLD: ' ', ANSWER_MAX_CHARS: '' })).toEqual(defaults);
  });

  it('reads every value from env', () => {
    expect(
      challengeLimits({
        CHALLENGE_SESSION_TTL_MIN: '30',
        CHALLENGE_MAX_GRADINGS_PER_CARD_HOUR: '2',
        CHALLENGE_BATCH_GRADE_MAX: '4',
        GEN_BATCH_SIZE: '6',
        GEN_DUP_THRESHOLD: '0.9',
        ANSWER_MAX_CHARS: '500',
      }),
    ).toEqual({ sessionTtlMin: 30, maxGradingsPerCardHour: 2, batchGradeMax: 4, genBatchSize: 6, dupThreshold: 0.9, answerMaxChars: 500 });
  });

  it('throws on a malformed value', () => {
    expect(() => challengeLimits({ GEN_DUP_THRESHOLD: '1.5' })).toThrow();
    expect(() => challengeLimits({ GEN_DUP_THRESHOLD: '0' })).toThrow();
    expect(() => challengeLimits({ ANSWER_MAX_CHARS: 'muito' })).toThrow();
    expect(() => challengeLimits({ GEN_BATCH_SIZE: '0' })).toThrow();
  });
});

describe('per-task models', () => {
  it('each task reads its own AI_MODEL_<TASK>', () => {
    const env = { AI_MODEL: 'base', AI_MODEL_GRADE: 'g', AI_MODEL_GENERATE: 'gen', AI_MODEL_SUMMARY: 's' };
    expect(challengeModelFor('grade', env)).toBe('g');
    expect(challengeModelFor('generate', env)).toBe('gen');
    expect(challengeModelFor('summary', env)).toBe('s');
  });

  it('empty or unset falls back to AI_MODEL', () => {
    const env = { AI_MODEL: 'base', AI_MODEL_GRADE: '', AI_MODEL_GENERATE: '   ' };
    expect(challengeModelFor('grade', env)).toBe('base');
    expect(challengeModelFor('generate', env)).toBe('base');
    expect(challengeModelFor('summary', env)).toBe('base');
    expect(challengeModelFor('grade', {})).toBeUndefined();
  });

  it('keeps AI_MODEL_GRADER for the legacy grader and does not mix the two', () => {
    const env = { AI_MODEL: 'base', AI_MODEL_GRADER: 'legacy' };
    expect(modelFor('grader', env)).toBe('legacy');
    expect(challengeModelFor('grade', env)).toBe('base');
    expect(modelFor('grader', { AI_MODEL: 'base', AI_MODEL_GRADE: 'new' })).toBe('base');
  });

  it('the chain puts the task model first, then AI_MODEL_FALLBACKS, without repeats', () => {
    expect(challengeChainFor('summary', { AI_MODEL: 'base', AI_MODEL_SUMMARY: 's', AI_MODEL_FALLBACKS: 's,f1' })).toEqual(['s', 'f1']);
  });
});
