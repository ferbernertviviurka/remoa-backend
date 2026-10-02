// Copy of remoa-frontend/packages/strings/src/account.ts `account.email.*` (the backend does not import @remoa/strings).
const plural = (n: number, one: string, other: string) => (n === 1 ? one : other).replace('#', String(n));

export const reminderEmail = ({ name, n, reviewUrl, unsubscribeUrl }: { name: string; n: number; reviewUrl: string; unsubscribeUrl: string }) => {
  const body = `${plural(n, 'Hoje vence # conceito', 'Hoje vencem # conceitos')} na sua fila. Revisar agora leva poucos minutos.`;
  const footer = 'Remoa · Você recebe este e-mail porque ligou o lembrete diário.';
  const unsub = `Não quer mais receber? Cancelar o lembrete: ${unsubscribeUrl}`;
  return {
    subject: plural(n, '# conceito vence hoje', '# conceitos vencem hoje'),
    text: `Oi, ${name}.\n\n${body}\n\nRevisar hoje: ${reviewUrl}\n\n${footer}\n${unsub}\n`,
  };
};

export const passwordChangedEmail = ({ name, date, resetUrl }: { name: string; date: string; resetUrl: string }) => ({
  subject: 'Sua senha do Remoa foi alterada',
  text: `Oi, ${name}.\n\nA senha da sua conta foi alterada em ${date}. Por segurança, encerramos a sessão nos outros dispositivos.\n\nNão foi você? Redefina sua senha agora e responda este e-mail.\nRedefinir senha: ${resetUrl}\n`,
});

export const unsubscribedPage = 'Lembrete diário desligado. Você pode ligar de novo em Minha conta, Preferências.';
export const unsubscribeConfirm = 'Desligar o lembrete diário do Remoa?';
export const unsubscribeButton = 'Desligar lembrete';
