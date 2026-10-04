// Referral emails. Copied from remoa-frontend/packages/strings/src/referral.ts
// The backend does not import @remoa/strings, so we keep copies here.

export const referralInviteEmail = ({
  referrerName,
  inviteLink,
  unsubscribeUrl,
}: {
  referrerName: string;
  inviteLink: string;
  unsubscribeUrl: string;
}) => {
  const body = `${referrerName} convidou você para estudar no Remoa, um mapa de estudo que testa pelas conexões entre os conceitos. Quando você criar seu primeiro mapa pelo link abaixo, vocês dois ganham 1 mês de Pro grátis.`;
  const footer = 'Remoa · Você recebeu este e-mail porque foi convidado para a plataforma.';
  const unsub = `Não quer receber mais convites? ${unsubscribeUrl}`;
  return {
    subject: `${referrerName} convidou você para o Remoa`,
    text: `Oi!\n\n${body}\n\nAbrir convite: ${inviteLink}\n\n${footer}\n${unsub}\n`,
  };
};

export const referralRewardGrantedReferrerEmail = ({
  referrerName,
  refereeName,
  referrerDashboardUrl,
  unsubscribeUrl,
}: {
  referrerName: string;
  refereeName: string;
  referrerDashboardUrl: string;
  unsubscribeUrl: string;
}) => {
  const body = `${refereeName} criou o primeiro mapa. Vocês dois ganharam 1 mês de Pro grátis! Acompanhe suas indicações no seu painel.`;
  const footer = 'Remoa · Você recebe este e-mail quando um convite seu é qualificado.';
  const unsub = `Não quer receber notificações? ${unsubscribeUrl}`;
  return {
    subject: '1 mês de Pro grátis para você!',
    text: `Oi, ${referrerName}!\n\n${body}\n\nVer no painel: ${referrerDashboardUrl}\n\n${footer}\n${unsub}\n`,
  };
};

export const referralRewardGrantedRefereeEmail = ({
  refereeName,
  referrerName,
  dashboardUrl,
  unsubscribeUrl,
}: {
  refereeName: string;
  referrerName: string;
  dashboardUrl: string;
  unsubscribeUrl: string;
}) => {
  const body = `Seu primeiro mapa está pronto! Você e ${referrerName} ganharam 1 mês de Pro grátis. Aproveite para revisar sem limites.`;
  const footer = 'Remoa · Você recebeu este e-mail porque uma indicação sua foi qualificada.';
  const unsub = `Não quer mais receber? ${unsubscribeUrl}`;
  return {
    subject: '1 mês de Pro grátis para você!',
    text: `Oi, ${refereeName}!\n\n${body}\n\nVer no painel: ${dashboardUrl}\n\n${footer}\n${unsub}\n`,
  };
};

// Unsubscribe page
export const referralUnsubscribePage = 'Você foi removido da lista de notificações de indicações. Pode ligar de novo em Minha conta, Preferências.';
export const referralUnsubscribeConfirm = 'Desligar notificações de indicações do Remoa?';
export const referralUnsubscribeButton = 'Desligar notificações';
