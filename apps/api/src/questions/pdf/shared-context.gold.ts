/** Authorial structural gold defined before the context extractor is executed. No clinical material. */
export const SHARED_CONTEXT_GOLD = {
  listCase: {
    targets: [1, 2],
    context: 'TEXTO PARA AS QUESTÕES 1 E 2\nNão substituir 2 kg por 2 mg.\n1. Primeiro elemento.\n2. Segundo elemento.',
    ownStems: ['Qual elemento mantém a unidade?', 'Qual alternativa contém a negação?'],
    numbers: [1, 2],
  },
  orphanCase: {
    targets: [7, 8],
    context: 'TEXTO PARA QUESTÕES 7 E 8\nNão alterar 0,2 L.\n1. Lista interna.\n2. Outra lista interna.',
    numbers: [],
  },
} as const;
