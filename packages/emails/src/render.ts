import { createElement } from 'react';
import { render as reactEmailRender } from '@react-email/render';
import { EMAIL_CLASS, type EmailClass, type EmailData, type EmailLinks, type EmailTemplate, type RenderedEmail } from '@remoa/contracts';
import { Layout } from './layout';
import { build } from './templates';

// Texto simples: titulos sem caixa alta, cada linha de tabela em sua linha, celulas separadas por espaco.
const TEXT_SELECTORS = [
  { selector: 'h1', options: { uppercase: false } },
  { selector: 'table', format: 'block' },
  { selector: 'tr', format: 'block' },
  { selector: 'td', format: 'inlineSurround', options: { prefix: ' ', suffix: ' ' } },
];
const tidy = (s: string) =>
  s.split('\n').map((l) => l.trim().replace(/ {2,}/g, ' ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();

export const templateClass = (template: EmailTemplate): EmailClass => EMAIL_CLASS[template];

/** `links` come from sendEmail (appUrl always; reminder/list also unsubscribe, preferences and, for reminders, pause). */
export async function render<T extends EmailTemplate>(template: T, data: EmailData<T>, links: EmailLinks): Promise<RenderedEmail> {
  const { subject, preheader, footer, body } = build(template, data, links);
  const el = createElement(Layout, { preheader, footer, children: body, appUrl: links.appUrl });
  const [html, text] = await Promise.all([
    reactEmailRender(el),
    // links por extenso: "texto [url]"; o preheader oculto tem data-skip-in-text
    reactEmailRender(el, { plainText: true, htmlToTextOptions: { selectors: TEXT_SELECTORS } }),
  ]);
  return { subject, preheader, html, text: tidy(text) };
}
