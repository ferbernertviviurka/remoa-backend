import { extractOffline } from '@remoa/ai';
import { describe, expect, it } from 'vitest';
import { ENAMED_ITEMS } from './enamed';
import { matrixCodeByTitle, studyOutlines } from './study-outlines';

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

  it('every seed map links to existing matrix items', () => {
    const codes = new Set(ENAMED_ITEMS.map((i) => i.code));
    for (const map of studyOutlines) {
      const linked = matrixCodeByTitle[map.title] ?? [];
      expect(linked.length).toBeGreaterThan(0);
      for (const c of linked) expect(codes.has(c)).toBe(true);
    }
  });
});
