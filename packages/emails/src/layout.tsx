/** @jsxRuntime automatic @jsxImportSource react */
import type { CSSProperties, ReactNode } from 'react';
import { Body, Head, Html } from '@react-email/components';
import { CALENDAR_PALETTE, type CalendarColor, type EmailClass } from '@remoa/contracts';
import { emails } from './strings';

// Tokens de docs/DESIGN.md (e-mail nao usa @remoa/ui, D-050). Estilos inline por exigencia dos clientes de e-mail.
const c = {
  bg: '#F6F5FB', card: '#FFFFFF', border: '#E3E0F1', line: '#EEEBF8', brand: '#6D5BD0', brandInk: '#3F3579',
  ink: '#1A1533', body: '#3A3558', muted: '#5F5B7A', faint: '#8F8AAE', btnBorder: '#D9D4F0', soft: '#F3F2FB',
  amberBg: '#FEF3C7', amber: '#CA8A04',
};
const head = "'Bricolage Grotesque','Trebuchet MS',Arial,sans-serif";
const sans = "'Instrument Sans','Segoe UI',Arial,Helvetica,sans-serif";
const f = (size: number | string, extra: CSSProperties = {}): CSSProperties => ({ fontFamily: sans, fontSize: size, ...extra });
// bgcolor nao existe nos tipos de <td>, mas e o que o Outlook le (botao a prova de falhas).
const bg = (color?: string): Record<string, string> => (color ? { bgcolor: color } : {});
const tbl = { role: 'presentation', cellPadding: 0, cellSpacing: 0, border: 0 } as const;

// Label chips and strips use the calendar palette of contracts (same tokens as the app, contrast tested there).
export type Tone = CalendarColor;

/** `reason`/`stopLabel` override the class defaults (CCR-035 templates). `legal` = razão social e endereço from the .env (P-304), when set. */
export interface FooterProps {
  kind: EmailClass;
  preferencesUrl?: string;
  unsubscribeUrl?: string;
  reason?: string;
  stopLabel?: string;
  legal?: string;
}

function Footer({ kind, preferencesUrl, unsubscribeUrl, reason, stopLabel, legal }: FooterProps) {
  const a = { color: c.brandInk };
  return (
    <td style={f(12.5, { padding: '20px 12px 8px', lineHeight: 1.6, color: c.faint, textAlign: 'center' })}>
      {reason ?? emails.footer[kind]}
      {kind === 'reminder' && (
        <>
          {' '}
          {preferencesUrl && (<><a href={preferencesUrl} style={a}>{emails.footer.manage}</a>{' · '}</>)}
          {unsubscribeUrl && <a href={unsubscribeUrl} style={a}>{stopLabel ?? emails.footer.stop}</a>}
        </>
      )}
      {kind === 'list' && unsubscribeUrl && (<>{' '}<a href={unsubscribeUrl} style={a}>{stopLabel ?? emails.footer.leaveList}</a></>)}
      <br /><br />
      Remoa
      {legal && (<><br />{legal}</>)}
    </td>
  );
}

export function Layout({ preheader, footer, children }: { preheader: string; footer: FooterProps; children: ReactNode }) {
  return (
    <Html lang="pt-BR">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Body style={{ margin: 0, padding: 0, background: c.bg }}>
        <div data-skip-in-text="true" style={{ display: 'none', maxHeight: 0, overflow: 'hidden', opacity: 0, color: 'transparent', msoHide: 'all' } as CSSProperties}>{preheader}</div>
        <table {...tbl} width="100%" {...bg(c.bg)} style={{ background: c.bg }}><tbody><tr>
          <td align="center" style={{ padding: '28px 14px' }}>
            <table {...tbl} width={600} style={{ width: '100%', maxWidth: 600 }}><tbody>
              <tr><td style={{ padding: '4px 8px 18px' }}>
                <span style={{ fontFamily: head, fontSize: 28, fontWeight: 800, letterSpacing: '-1.4px', color: c.brand }}>{emails.brand}</span>
              </td></tr>
              <tr><td {...bg(c.card)} style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 24, padding: '38px 36px 32px' }}>{children}</td></tr>
              <tr><Footer {...footer} /></tr>
            </tbody></table>
          </td>
        </tr></tbody></table>
      </Body>
    </Html>
  );
}

export const H1 = ({ children }: { children: ReactNode }) => (
  <h1 style={{ margin: '0 0 14px', fontFamily: head, fontSize: 30, lineHeight: 1.15, fontWeight: 800, letterSpacing: '-0.6px', color: c.ink }}>{children}</h1>
);

export const P = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <p style={f(size, { margin: '0 0 16px', lineHeight: 1.6, color: c.body })}>{children}</p>
);

export const Note = ({ children, last, mb = 24 }: { children: ReactNode; last?: boolean; mb?: number }) => (
  <p style={f(13, { margin: `0 0 ${last ? 0 : mb}px`, lineHeight: 1.6, color: c.muted })}>{children}</p>
);

export const Eyebrow = ({ children }: { children: ReactNode }) => (
  <div style={f(13, { fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase', color: c.faint, margin: '6px 0 4px' })}>{children}</div>
);

export const Spacer = ({ h }: { h: number }) => <div style={{ height: h }} />;

export function Button({ href, children, variant = 'primary' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' }) {
  const primary = variant === 'primary';
  return (
    <table {...tbl} style={{ margin: '6px 0 4px' }}><tbody><tr>
      <td {...bg(primary ? c.brand : undefined)} style={primary ? { borderRadius: 14 } : { border: `1.5px solid ${c.btnBorder}`, borderRadius: 14 }}>
        <a href={href} style={f(primary ? 16 : 15, { display: 'inline-block', padding: primary ? '16px 30px' : '14px 26px', lineHeight: '20px', fontWeight: 700, color: primary ? '#FFFFFF' : c.ink, textDecoration: 'none', borderRadius: 14 })}>{children}</a>
      </td>
    </tr></tbody></table>
  );
}

/** Link por extenso abaixo do botao critico (confirmacao, senha). */
export const FullLink = ({ intro, url }: { intro: string; url: string }) => (
  <Note>{intro}<br /><span style={{ color: c.brandInk, wordBreak: 'break-all' }}>{url}</span></Note>
);

export function Rows({ rows }: { rows: [string, string][] }) {
  const td: CSSProperties = { padding: '12px 0', borderTop: `1px solid ${c.line}` };
  return (
    <table {...tbl} width="100%" style={{ margin: '6px 0 20px', borderCollapse: 'collapse' }}><tbody>
      {rows.map(([k, v]) => (
        <tr key={k}>
          <td style={f(14, { ...td, color: c.muted })}>{k}</td>
          <td align="right" style={f(15, { ...td, fontWeight: 700, color: c.ink })}>{v}</td>
        </tr>
      ))}
    </tbody></table>
  );
}

export const Chip = ({ children, tone }: { children: ReactNode; tone: Tone }) => (
  <span style={f(12.5, { display: 'inline-block', padding: '4px 12px', borderRadius: 999, background: CALENDAR_PALETTE[tone].bg, color: CALENDAR_PALETTE[tone].text, fontWeight: 700 })}>{children}</span>
);

export function Callout({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'amber' }) {
  const amber = tone === 'amber';
  return (
    <table {...tbl} width="100%" style={{ margin: '8px 0 18px' }}><tbody><tr>
      <td {...bg(amber ? c.amberBg : c.bg)} style={f(14.5, { padding: '14px 18px', borderLeft: `4px solid ${amber ? c.amber : c.brand}`, borderRadius: 10, lineHeight: 1.55, color: c.body })}>{children}</td>
    </tr></tbody></table>
  );
}

export const CalloutLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} style={{ color: c.brandInk, fontWeight: 700 }}>{children}</a>
);

export function Steps({ items }: { items: readonly { title: string; text: string }[] }) {
  return (
    <table {...tbl} width="100%" style={{ margin: '6px 0 22px' }}><tbody>
      {items.map((s, i) => (
        <tr key={s.title}>
          <td width={44} valign="top" style={{ padding: '8px 0' }}>
            <table {...tbl}><tbody><tr>
              <td width={32} height={32} align="center" {...bg(c.soft)} style={f(14, { borderRadius: 16, fontWeight: 800, color: c.brandInk })}>{i + 1}</td>
            </tr></tbody></table>
          </td>
          <td valign="top" style={{ padding: '8px 0' }}>
            <div style={f(16, { fontWeight: 700, color: c.ink })}>{s.title}</div>
            <div style={f(14.5, { lineHeight: 1.5, color: c.muted })}>{s.text}</div>
          </td>
        </tr>
      ))}
    </tbody></table>
  );
}

export function Stats({ items }: { items: { value: string | number; label: string }[] }) {
  const w = `${Math.floor(100 / items.length)}%`;
  return (
    <table {...tbl} width="100%" style={{ margin: '6px 0 22px' }}><tbody><tr>
      {items.flatMap((it, i) => [
        ...(i ? [<td key={`g${i}`} width={8} />] : []),
        <td key={it.label} width={w} align="center" style={{ padding: '16px 6px', background: c.bg, borderRadius: 14 }}>
          <div style={{ fontFamily: head, fontSize: 30, fontWeight: 800, letterSpacing: '-0.5px', color: c.brandInk }}>{it.value}</div>
          <div style={f(13, { color: c.muted })}>{it.label}</div>
        </td>,
      ])}
    </tr></tbody></table>
  );
}

export const BigNumber = ({ value }: { value: string | number }) => (
  <div style={{ fontFamily: head, fontSize: 64, lineHeight: 1, fontWeight: 800, letterSpacing: '-2px', color: c.brandInk }}>{value}</div>
);

export const Subhead = ({ children }: { children: ReactNode }) => (
  <div style={f(18, { fontWeight: 700, color: c.ink, margin: '2px 0 14px' })}>{children}</div>
);

/** Faixa (sem imagem) na cor da etiqueta: usada quando nao ha capa. */
export const Strip = ({ tone }: { tone: Tone }) => (
  <table {...tbl} width="100%" style={{ margin: '0 0 18px' }}><tbody><tr>
    <td height={12} {...bg(CALENDAR_PALETTE[tone].dot)} style={{ borderRadius: 16, fontSize: 1, lineHeight: '12px' }}>&nbsp;</td>
  </tr></tbody></table>
);

/** Faixa decorativa do mapa pronto (so celulas coloridas, sem imagem). */
export function MapBand() {
  const cell = (color: string, k: string) => [
    <td key={k} width="30%" height={46} {...bg(color)} style={{ borderRadius: 10 }} />,
    <td key={`${k}g`} width="5%" />,
  ];
  return (
    <table {...tbl} width="100%" style={{ margin: '6px 0 20px' }}><tbody><tr>
      <td {...bg(c.bg)} style={{ padding: 18, borderRadius: 16, border: `1px solid ${c.border}` }}>
        <table {...tbl} width="100%"><tbody>
          <tr>{[c.brand, '#C9BFFF', c.amber].flatMap((x, i) => cell(x, `a${i}`))}</tr>
          <tr><td height={10} colSpan={6} /></tr>
          <tr>{['#C2410C', c.brand, '#B8B3D0'].flatMap((x, i) => cell(x, `b${i}`))}</tr>
        </tbody></table>
      </td>
    </tr></tbody></table>
  );
}

export const Cover = ({ src, alt }: { src: string; alt: string }) => (
  <>
    <img src={src} width={520} alt={alt} style={{ display: 'block', width: '100%', maxWidth: 520, height: 'auto', borderRadius: 16 }} />
    <Spacer h={18} />
  </>
);

export { c as colors, f as font };
