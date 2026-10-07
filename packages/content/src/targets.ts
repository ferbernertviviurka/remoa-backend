import type { MapFile } from '@remoa/contracts';

export type Metas = MapFile['mapa']['metas'];

/** FR-2 (F31): the only copy of the per-map targets. `mapa.yaml` repeats them and `content:lint` checks both agree. */
export const TARGETS: Record<string, Metas> = {
  sepse: { cards: 90, casos: 6, fluxogramas: 5, imagens: 6, macetes: 8, pegadinhas: 10 },
  'sus-politicas-de-saude': { cards: 100, casos: 5, fluxogramas: 3, imagens: 5, macetes: 10, pegadinhas: 10 },
  sca: { cards: 110, casos: 7, fluxogramas: 6, imagens: 8, macetes: 10, pegadinhas: 10 },
  'diabetes-tipo-2': { cards: 110, casos: 6, fluxogramas: 5, imagens: 6, macetes: 10, pegadinhas: 10 },
  'insuficiencia-cardiaca': { cards: 110, casos: 6, fluxogramas: 5, imagens: 7, macetes: 10, pegadinhas: 10 },
  'aps-medicina-de-familia': { cards: 90, casos: 5, fluxogramas: 3, imagens: 4, macetes: 10, pegadinhas: 10 },
  'asma-dpoc': { cards: 100, casos: 6, fluxogramas: 6, imagens: 6, macetes: 8, pegadinhas: 10 },
  'vacinacao-puericultura-infancia': { cards: 120, casos: 6, fluxogramas: 4, imagens: 6, macetes: 12, pegadinhas: 10 },
  tireoide: { cards: 90, casos: 5, fluxogramas: 4, imagens: 6, macetes: 8, pegadinhas: 10 },
  'etica-declaracao-de-obito': { cards: 80, casos: 6, fluxogramas: 3, imagens: 4, macetes: 8, pegadinhas: 10 },
};

/** Goal of F31: every map has 80 to 120 cards (`content:lint` errors outside it). */
export const CARD_RANGE = { min: 80, max: 120 };

/** What a map actually has, in the same keys as `metas` (lint and report). */
export function tally(map: MapFile): Metas {
  const of = (t: string) => map.cards.filter((c) => c.tipo === t).length;
  return {
    cards: map.cards.length,
    casos: of('caso'),
    fluxogramas: of('fluxograma'),
    imagens: of('imagem'),
    macetes: map.cards.filter((c) => c.macete).length,
    pegadinhas: map.cards.filter((c) => c.pegadinha).length,
  };
}
