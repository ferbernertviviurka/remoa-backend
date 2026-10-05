// Support emails. Copied from remoa-frontend/packages/strings/src/support.ts
// The backend does not import @remoa/strings, so we keep copies here.

export const supportTicketReceivedEmail = ({
  userName,
  ticketNumber,
  ticketUrl,
  unsubscribeUrl,
}: {
  userName: string;
  ticketNumber: number;
  ticketUrl: string;
  unsubscribeUrl: string;
}) => {
  const body = `Recebemos seu chamado #${ticketNumber}. Nossa equipe analisará em breve e responderá com a maior urgência possível.`;
  const footer = 'Remoa · Você recebeu este e-mail porque abriu um chamado de suporte.';
  const unsub = `Não quer receber atualizações? ${unsubscribeUrl}`;
  return {
    subject: `Chamado #${ticketNumber} recebido`,
    text: `Oi, ${userName}!\n\n${body}\n\nVer chamado: ${ticketUrl}\n\n${footer}\n${unsub}\n`,
  };
};

export const supportTicketAnsweredEmail = ({
  userName,
  ticketNumber,
  ticketUrl,
  unsubscribeUrl,
}: {
  userName: string;
  ticketNumber: number;
  ticketUrl: string;
  unsubscribeUrl: string;
}) => {
  const body = `A equipe respondeu ao seu chamado #${ticketNumber}. Acesse o link abaixo para ler a resposta e continuar a conversa.`;
  const footer = 'Remoa · Você recebeu este e-mail porque a equipe respondeu a seu chamado de suporte.';
  const unsub = `Não quer mais notificações? ${unsubscribeUrl}`;
  return {
    subject: `Resposta ao chamado #${ticketNumber}`,
    text: `Oi, ${userName}!\n\n${body}\n\nVer resposta: ${ticketUrl}\n\n${footer}\n${unsub}\n`,
  };
};

// Admin notification emails (FR-21: data export alerts)

export const adminExportUsersEmail = ({
  adminName,
  exportCount,
  exportDate,
  adminDashboardUrl,
}: {
  adminName: string;
  exportCount: number;
  exportDate: string;
  adminDashboardUrl: string;
}) => {
  const body = `Uma exportação de ${exportCount} usuário${exportCount !== 1 ? 's' : ''} foi realizada em ${exportDate}. Verifique no painel de administração se foi autorizada.`;
  const footer = 'Remoa Admin · Este e-mail é enviado sempre que dados são exportados.';
  return {
    subject: 'Alerta: exportação de dados',
    text: `Oi, ${adminName}!\n\n${body}\n\nAcessar painel: ${adminDashboardUrl}\n\n${footer}\n`,
  };
};

export const adminExportPaymentsEmail = ({
  adminName,
  exportCount,
  exportDate,
  adminDashboardUrl,
}: {
  adminName: string;
  exportCount: number;
  exportDate: string;
  adminDashboardUrl: string;
}) => {
  const body = `Uma exportação de ${exportCount} ${exportCount !== 1 ? 'transações' : 'transação'} foi realizada em ${exportDate}. Verifique no painel de administração se foi autorizada.`;
  const footer = 'Remoa Admin · Este e-mail é enviado sempre que dados são exportados.';
  return {
    subject: 'Alerta: exportação de dados',
    text: `Oi, ${adminName}!\n\n${body}\n\nAcessar painel: ${adminDashboardUrl}\n\n${footer}\n`,
  };
};

// Unsubscribe pages

export const supportUnsubscribePage =
  'Você foi removido da lista de notificações de suporte. Pode ativar de novo em Minha conta, Preferências.';
export const supportUnsubscribeConfirm = 'Desligar notificações de suporte do Remoa?';
export const supportUnsubscribeButton = 'Desligar notificações';

// F19 T4 FR-16: "Reenviar recibo" (admin). Transactional: no unsubscribe link.
export const paymentReceiptEmail = ({ userName, receiptUrl }: { userName: string; receiptUrl: string }) => ({
  subject: 'Seu recibo do Remoa',
  text: `Oi, ${userName}!\n\nAqui está o recibo do seu pagamento no Remoa.\n\nVer recibo: ${receiptUrl}\n\nRemoa · Você recebeu este e-mail porque a equipe reenviou o recibo de um pagamento seu.\n`,
});
