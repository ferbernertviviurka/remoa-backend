import { describe, expect, it } from 'vitest';
import { cardContentHash, matchClosedTopic, rubricFromAnswer } from './rubric';

describe('card rubric helpers', () => {
  it('hashes front, back and porQue, and changes when any of them changes', () => {
    const a = cardContentHash('frente', 'verso', 'porque');
    expect(a).toHaveLength(64);
    expect(cardContentHash('frente', 'verso', 'porque')).toBe(a);
    expect(cardContentHash('outra', 'verso', 'porque')).not.toBe(a);
    expect(cardContentHash('frente', 'verso', null)).not.toBe(a);
  });

  it('splits the expected answer into essential points and invents no critical error', () => {
    const r = rubricFromAnswer('Alfa sobe. Beta cai.');
    expect(r).toEqual({ essentialPoints: ['Alfa sobe.', 'Beta cai.'], acceptedVariants: [], criticalErrors: [], status: 'auto' });
    expect(rubricFromAnswer('   ')).toBeNull();
  });

  it('accepts a topic only from the closed list, by code or by name', () => {
    const topics = [{ id: 't1', code: 'CM-01', name: 'Sepse' }];
    expect(matchClosedTopic('CM-01', topics)).toBe('t1');
    expect(matchClosedTopic('sepse', topics)).toBe('t1');
    expect(matchClosedTopic('choque inventado', topics)).toBeNull();
    expect(matchClosedTopic(null, topics)).toBeNull();
  });
});
