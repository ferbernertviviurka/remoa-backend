import { extractOffline } from '@remoa/ai';
import { describe, expect, it } from 'vitest';
import { studyOutlines } from './study-outlines';

describe('study outlines', () => {
  it('builds the five seed maps through the F05 extractor', () => {
    expect(studyOutlines).toHaveLength(5);
    for (const map of studyOutlines) {
      const extracted = extractOffline(map.text, map.source);
      expect(extracted.cards.some((c) => c.type === 'flow')).toBe(true);
      expect(extracted.cards.some((c) => c.type === 'case')).toBe(true);
      expect(extracted.cards.every((c) => c.source === map.source)).toBe(true);
      expect(extracted.edges.length).toBeGreaterThan(0);
    }
  });
});
