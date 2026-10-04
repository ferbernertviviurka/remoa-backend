const STUB_TAILS = [': definição', ': conduta', ': o que não esquecer'] as const;

/** The first seed wrote keyword stubs, then added one case and two flows by title. A reviewed card is not a stub. */
export function isUntouchedStubSeed(boardTitle: string, cards: { title: string; status: string }[]): boolean {
  if (cards.length === 0) return false;
  const overlays = new Set([`Conduta de ${boardTitle}`, `Reavaliação de ${boardTitle}`, `Caso de ${boardTitle}`]);
  return cards.every((card) => card.status === 'draft' && (overlays.has(card.title) || STUB_TAILS.some((tail) => card.title.endsWith(tail))));
}
