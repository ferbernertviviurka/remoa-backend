import { describe, expect, it } from 'vitest';
import type { EmailData } from '@remoa/contracts';
import { emailSamples, render, sampleData, sampleLinks, templateClass } from './index';

const SUBJECTS: Record<string, string> = {
  'account-confirm/signup': 'Confirme seu e-mail e comece no Remoa',
  'account-confirm/email_change': 'Confirme seu e-mail e comece no Remoa',
  'account-confirm/magiclink': 'Seu link para entrar no Remoa',
  'purchase-success/default': 'Pagamento confirmado: Remoa Pro',
  'password-reset/default': 'Redefina sua senha do Remoa',
  'calendar-reminder/d1': 'Amanhã: Prova de Clínica Médica',
  'calendar-reminder/d0': 'Hoje: Prova de Clínica Médica às 10:00',
  'calendar-reminder/varios': 'Amanhã você tem 3 compromissos',
  'inactivity/default': 'Faz 12 dias que a gente não se vê',
  'review-reminder/default': '18 cards esperam por você hoje',
  'map-ready/default': 'Seu mapa “Insuficiência cardíaca” está pronto',
  'waitlist-confirm/comprar': 'Você está na lista da Loja de mapas',
  'waitlist-confirm/vender': 'Você está na lista da Loja de mapas',
  'support-reply/received': 'Chamado #128 recebido',
  'support-reply/answered': 'Resposta ao chamado #128',
  'referral-reward/referrer': '1 mês de Pro grátis para você!',
  'referral-reward/referee': '1 mês de Pro grátis para você!',
  'trial-ending/d3': 'Seu teste do Pro termina em 3 dias',
  'trial-ending/d0': 'Seu teste do Pro termina hoje',
  'referral-invite/default': 'Ana convidou você para o Remoa',
  'password-changed/default': 'Sua senha do Remoa foi alterada',
  'welcome/default': 'Boas-vindas ao Remoa',
  'onboarding-nudge/first_map': 'Seu mapa está pronto para revisar',
  'onboarding-nudge/day3': 'Que tal fazer sua primeira sessão?',
  'payment-receipt/default': 'Seu recibo do Remoa',
  'admin-alert/export_users': 'Alerta: exportação de dados',
  'admin-alert/export_payments': 'Alerta: exportação de dados',
  'dispute-resolved/default': 'Sua discordância foi revista',
  'landing-waitlist/default': 'Você está na lista de espera do Remoa',
};
const PREHEADERS: Record<string, string> = {
  'calendar-reminder/varios': 'Prova de Clínica Médica, Plantão no pronto-socorro e mais 1.',
  'calendar-reminder/d0': '10:00 · Sala 204 · Bloco B',
  'review-reminder/default': 'Cerca de 9 minutos para fixar o que vence hoje.',
  'password-reset/default': 'O link vale por 1 hora.',
  'account-confirm/signup': 'Falta só um clique para criar seu primeiro mapa.',
};

const urls = (s: string) => [...s.replace(/<!DOCTYPE[^>]*>/i, '').matchAll(/https?:\/\/[^\s"'<>\])]+/g)].map((m) => m[0]);
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => (m[1] ?? '').replaceAll('&amp;', '&'));

it('every sample has an expected subject', () => {
  expect(emailSamples.map((e) => `${e.template}/${e.version}`).sort()).toEqual(Object.keys(SUBJECTS).sort());
});

describe.each(emailSamples)('$template / $version', ({ template, version }) => {
  const key = `${template}/${version}`;
  const data = sampleData(template, version);
  const links = sampleLinks(template);
  const out = render(template, data, links);

  it('assunto e preheader', async () => {
    const r = await out;
    expect(r.subject).toBe(SUBJECTS[key]);
    expect(r.preheader.length).toBeGreaterThan(0);
    if (PREHEADERS[key]) expect(r.preheader).toBe(PREHEADERS[key]);
    expect(r.html).toContain(r.preheader);
  });

  it('html < 100 KB, sem placeholders, sem rastreio', async () => {
    const { html, text } = await out;
    expect(Buffer.byteLength(html)).toBeLessThan(100 * 1024);
    for (const s of [html, text]) expect(s).not.toMatch(/\{\{|\}\}|\{\w+\}|undefined|null|NaN|\[object/);
    expect(html).not.toMatch(/width="1"\s+height="1"|height="1"\s+width="1"/);
  });

  it('links absolutos so os passados; toda img tem alt', async () => {
    const { html, text } = await out;
    const given = new Set([...urls(JSON.stringify({ data, links })), `${links.appUrl}/email/logo.png`]);
    for (const u of [...urls(html), ...urls(text)]) expect(given.has(u.replace(/&amp;/g, '&')), u).toBe(true);
    for (const h of hrefs(html)) expect(h).toMatch(/^https?:\/\//);
    for (const tag of html.match(/<img\b[^>]*>/g) ?? []) expect(tag).toMatch(/\balt="/);
  });

  it('texto simples legivel com os links por extenso', async () => {
    const { html, text } = await out;
    expect(text.trim().length).toBeGreaterThan(50);
    expect(text).not.toMatch(/<[a-z]/);
    for (const h of new Set(hrefs(html))) expect(text).toContain(h);
  });

  it('link de saida: lembrete e lista sim, transacional nao', async () => {
    const { html, text } = await out;
    const kind = templateClass(template);
    expect(hrefs(html).includes(links.unsubscribeUrl ?? '-')).toBe(kind !== 'transactional');
    if (kind !== 'transactional') expect(text).toContain(links.unsubscribeUrl);
    expect(html.includes('Gerenciar notificações')).toBe(kind === 'reminder');
  });

  it('instantaneo html', async () => {
    const { html } = await out;
    await expect(html).toMatchFileSnapshot(`./__snapshots__/${template}-${version}.html`);
  });
});

describe('regras gerais', () => {
  it('classes', () => {
    expect(templateClass('calendar-reminder')).toBe('reminder');
    expect(templateClass('waitlist-confirm')).toBe('list');
    expect(templateClass('map-ready')).toBe('transactional');
    expect(templateClass('referral-invite')).toBe('list');
  });

  it('capa opcional: com imagem usa img com alt, sem imagem usa faixa', async () => {
    const d = sampleData('calendar-reminder', 'd1');
    const links = sampleLinks('calendar-reminder');
    expect((await render('calendar-reminder', d, links)).html).not.toMatch(/<img[^>]*Capa do compromisso/);
    const withCover = await render('calendar-reminder', { ...d, coverUrl: 'https://cdn.exemplo.test/capa.webp' } as typeof d, links);
    expect(withCover.html).toMatch(/<img[^>]*alt="Capa do compromisso/);
  });

  it('link por extenso na confirmacao e na senha', async () => {
    for (const t of ['account-confirm', 'password-reset'] as const) {
      const d = sampleData(t);
      const url = 'confirmUrl' in d ? d.confirmUrl : d.resetUrl;
      const { html } = await render(t, d as never, sampleLinks(t));
      expect(html.split(url).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it('P-306: singular com 1 card', async () => {
    const d = { ...sampleData('review-reminder'), cards: 1, overdue: 1, newCards: 0, maps: [{ title: 'Sepse', cards: 1 }] };
    const r = await render('review-reminder', d, sampleLinks('review-reminder'));
    expect(r.subject).toBe('1 card espera por você hoje');
    expect(r.text).toContain('card espera por você');
    expect(r.text).toContain('1 vencido e 0 novos');
    expect(r.text).toContain('1 card');
    expect(r.text).not.toMatch(/\b1 cards\b/);
  });

  it('valores crus formatados em pt-BR no fuso dado', async () => {
    const p = await render('purchase-success', sampleData('purchase-success'), sampleLinks('purchase-success'));
    expect(p.text).toMatch(/R\$\s29,90/);
    expect(p.text).toContain('Pix');
    expect(p.text).toContain('1 de outubro de 2026');
    const allDay = { ...sampleData('calendar-reminder', 'd0'), allDay: true } as EmailData<'calendar-reminder'>;
    const c = await render('calendar-reminder', allDay, sampleLinks('calendar-reminder'));
    expect(c.subject).toBe('Hoje: Prova de Clínica Médica');
    expect(c.text).toContain('Dia inteiro');
  });

  it('sem nome: sem saudacao vazia', async () => {
    const r = await render('support-reply', { ...sampleData('support-reply', 'answered'), name: null }, sampleLinks('support-reply'));
    expect(r.text).toContain('Oi. A equipe respondeu');
  });
});

it('P-304: the legal line (razão social e endereço) shows in the footer only when sendEmail passes it', async () => {
  const legal = 'Remoa Educação Ltda. · Rua Exemplo, 100';
  const withIt = await render('welcome', sampleData('welcome'), { ...sampleLinks('welcome'), legal });
  expect(withIt.html).toContain(legal);
  expect(withIt.text).toContain(legal);
  expect((await render('welcome', sampleData('welcome'), sampleLinks('welcome'))).html).not.toContain(legal);
});
