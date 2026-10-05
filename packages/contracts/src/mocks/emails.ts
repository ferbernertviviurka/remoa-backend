// G18 / F24: example data for the 11 versions (+ 14 of CCR-035) (render tests, /dev/emails, emails:test). Fictional values, relative to FIXTURE_NOW.
import type { EmailData, EmailLinks, EmailTemplate } from '../emails';
import { FIXTURE_NOW, MOCK_APP_URL, fid } from './fixtures';

const iso = (hours: number) => new Date(FIXTURE_NOW.getTime() + hours * 3_600_000).toISOString();
const tz = 'America/Sao_Paulo';
const exam = { eventId: fid(9102), title: 'Prova de Clínica Médica', labelName: 'Prova', labelColor: 'orange', startsAt: iso(23), endsAt: iso(25), allDay: false, location: 'Sala 204 · Bloco B' } as const;
const d1 = {
  version: 'd1', ...exam, timezone: tz, description: 'Capítulos 1 a 6: sepse, insuficiência cardíaca e pneumonia.', coverUrl: null,
  calendarUrl: `${MOCK_APP_URL}/app/calendario`, icsUrl: 'https://api.remoa.mock/v1/public/calendar/tok.ics', dueCards: 12, reviewUrl: `${MOCK_APP_URL}/app/revisar`,
} as const;

type Example = { [T in EmailTemplate]: { template: T; version: string; data: EmailData<T> } }[EmailTemplate];
export const emailExamples: Example[] = [
  { template: 'account-confirm', version: 'signup', data: { version: 'signup', name: 'Ana', confirmUrl: 'https://auth.remoa.mock/verify?token=t' } },
  { template: 'account-confirm', version: 'email_change', data: { version: 'email_change', name: 'Ana', confirmUrl: 'https://auth.remoa.mock/verify?token=t' } },
  { template: 'account-confirm', version: 'magiclink', data: { version: 'magiclink', name: 'Ana', confirmUrl: 'https://auth.remoa.mock/verify?token=t' } },
  { template: 'purchase-success', version: 'default', data: { name: 'Ana', planName: 'Remoa Pro', amountCents: 2990, currency: 'BRL', method: 'pix', paidAt: iso(0), nextChargeAt: iso(24 * 30), orderId: 'in_1Q2W3E', manageUrl: `${MOCK_APP_URL}/app/conta/plano`, timezone: tz } },
  { template: 'password-reset', version: 'default', data: { email: 'ana@exemplo.com', resetUrl: 'https://auth.remoa.mock/verify?token=r', device: 'Chrome no macOS', requestedAt: iso(0), timezone: tz } },
  { template: 'calendar-reminder', version: 'd1', data: d1 },
  { template: 'calendar-reminder', version: 'd0', data: { ...d1, version: 'd0', startsAt: iso(1) } },
  { template: 'calendar-reminder', version: 'varios', data: { version: 'varios', window: 'd1', name: 'Ana', date: iso(24).slice(0, 10), timezone: tz, calendarUrl: `${MOCK_APP_URL}/app/calendario`,
    events: [exam, { ...exam, eventId: fid(9103), title: 'Entrega de Epidemiologia', labelName: 'Trabalho', labelColor: 'amber', startsAt: iso(35), endsAt: null, location: null }, { ...exam, eventId: fid(9105), title: 'Plantão no pronto-socorro', labelName: 'Plantão', labelColor: 'teal', startsAt: iso(31), endsAt: iso(35) }] } },
  { template: 'inactivity', version: 'default', data: { name: 'Ana', days: 12, dueCards: 34, maps: 5, nextEvent: { title: exam.title, startsAt: exam.startsAt, allDay: false }, timezone: tz, resumeUrl: `${MOCK_APP_URL}/app/revisar?curta=1` } },
  { template: 'review-reminder', version: 'default', data: { name: 'Ana', cards: 18, overdue: 6, newCards: 12, minutes: 9, maps: [{ title: 'Sepse', cards: 8 }, { title: 'Insuficiência cardíaca', cards: 6 }, { title: 'Pneumonia', cards: 4 }], reviewUrl: `${MOCK_APP_URL}/app/revisar` } },
  { template: 'map-ready', version: 'default', data: { mapTitle: 'Insuficiência cardíaca', cards: 24, connections: 31, origin: 'pdf', mapUrl: `${MOCK_APP_URL}/app/mapas/${fid(8102)}` } },
  { template: 'waitlist-confirm', version: 'comprar', data: { version: 'comprar', name: 'Ana', sellerRole: null, storeUrl: `${MOCK_APP_URL}/app/loja` } },
  { template: 'waitlist-confirm', version: 'vender', data: { version: 'vender', name: 'Ana', sellerRole: 'teacher', storeUrl: `${MOCK_APP_URL}/app/loja` } },
  // CCR-035: the legacy notices, now templates.
  { template: 'support-reply', version: 'received', data: { version: 'received', name: 'Ana', ticketNumber: 128, ticketUrl: `${MOCK_APP_URL}/app/hoje?suporte=${fid(9301)}` } },
  { template: 'support-reply', version: 'answered', data: { version: 'answered', name: 'Ana', ticketNumber: 128, ticketUrl: `${MOCK_APP_URL}/app/hoje?suporte=${fid(9301)}` } },
  { template: 'referral-reward', version: 'referrer', data: { version: 'referrer', name: 'Ana', friendName: 'Bruno', dashboardUrl: `${MOCK_APP_URL}/app/indicar` } },
  { template: 'referral-reward', version: 'referee', data: { version: 'referee', name: 'Bruno', friendName: 'Ana', dashboardUrl: `${MOCK_APP_URL}/app/indicar` } },
  { template: 'referral-invite', version: 'default', data: { referrerName: 'Ana', inviteUrl: `${MOCK_APP_URL}/c/ANA123` } },
  { template: 'password-changed', version: 'default', data: { name: 'Ana', changedAt: iso(0), timezone: tz, resetUrl: `${MOCK_APP_URL}/entrar` } },
  { template: 'welcome', version: 'default', data: { name: 'Ana', startUrl: `${MOCK_APP_URL}/app` } },
  { template: 'onboarding-nudge', version: 'first_map', data: { version: 'first_map', name: 'Ana', actionUrl: `${MOCK_APP_URL}/app/revisar` } },
  { template: 'onboarding-nudge', version: 'day3', data: { version: 'day3', name: 'Ana', actionUrl: `${MOCK_APP_URL}/app` } },
  { template: 'payment-receipt', version: 'default', data: { name: 'Ana', receiptUrl: 'https://pay.remoa.mock/receipts/r_123' } },
  { template: 'admin-alert', version: 'export_users', data: { version: 'export_users', name: 'Carla', count: 42, at: iso(0), timezone: tz, auditUrl: `${MOCK_APP_URL}/admin/auditoria` } },
  { template: 'admin-alert', version: 'export_payments', data: { version: 'export_payments', name: 'Carla', count: 1, at: iso(0), timezone: tz, auditUrl: `${MOCK_APP_URL}/admin/auditoria` } },
  { template: 'dispute-resolved', version: 'default', data: { name: 'Ana' } },
  { template: 'landing-waitlist', version: 'default', data: {} },
];

export const emailLinksExample: Required<EmailLinks> = {
  appUrl: MOCK_APP_URL,
  preferencesUrl: `${MOCK_APP_URL}/app/notificacoes`,
  unsubscribeUrl: 'https://api.remoa.mock/v1/emails/unsubscribe?token=tok',
  pauseUrl: 'https://api.remoa.mock/v1/emails/unsubscribe?token=tok&pause=1',
  legal: 'Remoa Educação Ltda. · Rua Exemplo, 100, São Paulo, SP',
};
