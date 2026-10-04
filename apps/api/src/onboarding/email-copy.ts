// F12 FR-8 e-mail copy (pt-BR). The backend does not import @remoa/strings (same convention as account/email-copy.ts).
const footer = 'Remoa · Você recebe este e-mail porque criou uma conta.';

export const welcomeEmail = ({ name, url }: { name: string; url: string }) => ({
  subject: 'Boas-vindas ao Remoa',
  text: `Oi, ${name}.\n\nO Remoa é o seu mapa de estudo: cards conectados, revisão espaçada e desafios sobre o próprio mapa. Comece pelo primeiro mapa, leva uns 5 minutos.\n\nAbrir o Remoa: ${url}\n\n${footer}\n`,
});

export const mapReadyEmail = ({ name, url }: { name: string; url: string }) => ({
  subject: 'Seu mapa está pronto',
  text: `Oi, ${name}.\n\nSeu primeiro mapa já passou de 20 cards. Revise agora e veja a lembrança estimada de cada conceito.\n\nRevisar agora: ${url}\n\n${footer}\n`,
});

export const day3Email = ({ name, url }: { name: string; url: string }) => ({
  subject: 'Que tal fazer sua primeira sessão?',
  text: `Oi, ${name}.\n\nJá se passaram 3 dias e você ainda não fez uma sessão. Uma revisão rápida ou um desafio sobre o seu mapa já conta.\n\nComeçar agora: ${url}\n\n${footer}\n`,
});
