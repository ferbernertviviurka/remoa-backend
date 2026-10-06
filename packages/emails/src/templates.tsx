/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from 'react';
import { EMAIL_CLASS, type EmailClass, type EmailData, type EmailLinks, type EmailTemplate } from '@remoa/contracts';
import {
  BigNumber, Button, Callout, CalloutLink, Chip, Cover, Eyebrow, FullLink, H1, MapBand, Note, P, Rows, Spacer, Stats, Steps, Strip,
  Subhead,
} from './layout';
import type { FooterProps } from './layout';
import { clock, dateFull, dateLong, dateTime, emails as s, fmt, hoursLabel, localDateLong, money, pl } from './strings';

export interface Built { subject: string; preheader: string; footer: FooterProps; body: ReactNode }
type Parts = Omit<Built, 'footer'> & { footer?: Partial<FooterProps> };
type D<T extends EmailTemplate> = EmailData<T>;

/** Supabase link lifetimes (auth config, not product limits): confirmation 24 h, reset 1 h. */
const LINK_HOURS = { confirm: 24, reset: 1 } as const;
/** "Retomar com 5 minutos": the short session of F03. */
const SHORT_SESSION_MINUTES = 5;

const hi = (name: string | null) => (name ? fmt(s.hi, { name }) : s.hiNoName);

function accountConfirm(d: D<'account-confirm'>): Parts {
  const a = s.accountConfirm;
  if (d.version === 'magiclink') {
    return {
      subject: a.magicSubject,
      preheader: a.magicPreheader,
      body: (
        <>
          <H1>{d.name ? fmt(a.magicTitle, { name: d.name }) : a.magicTitleNoName}</H1>
          <P>{a.magicBody}</P>
          <Button href={d.confirmUrl}>{a.magicButton}</Button>
          <FullLink intro={fmt(a.linkNote, { expires: hoursLabel(LINK_HOURS.confirm) })} url={d.confirmUrl} />
          <Note last>{a.magicNotYou}</Note>
        </>
      ),
    };
  }
  const change = d.version === 'email_change';
  const t = change ? a.changeTitle : a.title;
  const tNo = change ? a.changeTitleNoName : a.titleNoName;
  return {
    subject: a.subject,
    preheader: change ? a.changePreheader : a.preheader,
    body: (
      <>
        <H1>{d.name ? fmt(t, { name: d.name }) : tNo}</H1>
        <P>{change ? a.changeBody : a.body}</P>
        <Button href={d.confirmUrl}>{a.button}</Button>
        <FullLink intro={fmt(a.linkNote, { expires: hoursLabel(LINK_HOURS.confirm) })} url={d.confirmUrl} />
        {!change && (<><Eyebrow>{a.stepsTitle}</Eyebrow><Steps items={a.steps} /></>)}
        <Note last>{change ? a.changeNotYou : a.notYou}</Note>
      </>
    ),
  };
}

function purchase(d: D<'purchase-success'>, links: EmailLinks): Parts {
  const p = s.purchase;
  const rows: [string, string][] = [[p.plan, d.planName], [p.amount, money(d.amountCents)], [p.method, p.methods[d.method]], [p.date, dateFull(d.paidAt, d.timezone)]];
  if (d.nextChargeAt) rows.push([p.nextCharge, dateFull(d.nextChargeAt, d.timezone)]);
  rows.push([p.order, d.orderId]);
  return {
    subject: fmt(p.subject, { plan: d.planName }),
    preheader: fmt(p.preheader, { plan: d.planName }),
    body: (
      <>
        <H1>{p.title}</H1>
        <P>{fmt(d.name ? p.body : p.bodyNoName, { name: d.name ?? '', plan: d.planName })}</P>
        <Rows rows={rows} />
        <Button href={links.appUrl}>{p.openApp}</Button>
        <Spacer h={6} />
        <Button href={d.manageUrl} variant="secondary">{p.manage}</Button>
        <Note last>{p.receipt}</Note>
      </>
    ),
  };
}

function passwordReset(d: D<'password-reset'>): Parts {
  const p = s.passwordReset;
  const expires = hoursLabel(LINK_HOURS.reset);
  const date = dateTime(d.requestedAt, d.timezone);
  return {
    subject: p.subject,
    preheader: fmt(p.preheader, { expires }),
    body: (
      <>
        <H1>{p.title}</H1>
        <P>{fmt(p.body, { email: d.email })}</P>
        <Button href={d.resetUrl}>{p.button}</Button>
        <FullLink intro={fmt(p.linkNote, { expires })} url={d.resetUrl} />
        <Callout tone="amber"><b>{p.notYouBold}</b>{p.notYou}</Callout>
        <Note last>{d.device ? fmt(p.request, { device: d.device, date }) : fmt(p.requestNoDevice, { date })}</Note>
      </>
    ),
  };
}

type CalendarOne = Extract<D<'calendar-reminder'>, { version: 'd1' | 'd0' }>;
type CalendarMany = Extract<D<'calendar-reminder'>, { version: 'varios' }>;
const hourOf = (e: { startsAt: string; allDay: boolean }, tz: string) => (e.allDay ? s.calendar.allDay : clock(e.startsAt, tz));

function calendarSingle(d: CalendarOne): Parts {
  const c = s.calendar;
  const d0 = d.version === 'd0';
  const time = hourOf(d, d.timezone);
  return {
    subject: fmt(!d0 ? c.subjectD1 : d.allDay ? c.subjectD0AllDay : c.subjectD0, { title: d.title, time }),
    preheader: d.location ? fmt(c.preheaderSingle, { time, location: d.location }) : fmt(c.preheaderSingleNoPlace, { time }),
    body: (
      <>
        <Chip tone={d.labelColor}>{d.labelName}</Chip>
        <Spacer h={12} />
        <H1>{fmt(d0 ? c.titleD0 : c.titleD1, { title: d.title })}</H1>
        {d.coverUrl ? <Cover src={d.coverUrl} alt={fmt(c.coverAlt, { title: d.title })} /> : <Strip tone={d.labelColor} />}
        <Rows rows={[[c.day, dateLong(d.startsAt, d.timezone)], [c.time, time], ...(d.location ? [[c.place, d.location] as [string, string]] : [])]} />
        {d.description && <P size={15}>{d.description}</P>}
        <Button href={d.calendarUrl}>{c.cta}</Button>
        <Spacer h={6} />
        <Button href={d.icsUrl} variant="secondary">{c.ics}</Button>
        {d.dueCards > 0 && (
          <Callout>
            {pl(c.dueCards, d.dueCards)}{' '}<CalloutLink href={d.reviewUrl}>{c.reviewNow}</CalloutLink>
          </Callout>
        )}
      </>
    ),
  };
}

function calendarMany(d: CalendarMany): Parts {
  const c = s.calendar;
  const count = d.events.length;
  const d0 = d.window === 'd0';
  // all-day first, then by start
  const events = [...d.events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const names = events.slice(0, 2).map((e) => e.title);
  const rest = count - names.length;
  const td = { padding: '12px 0', borderTop: '1px solid #EEEBF8' } as const;
  const sans = "'Instrument Sans','Segoe UI',Arial,Helvetica,sans-serif";
  return {
    subject: fmt(d0 ? c.subjectManyD0 : c.subjectMany, { count }),
    preheader: `${names.join(', ')}${rest > 0 ? ` ${fmt(c.moreItems, { count: rest })}` : ''}.`,
    body: (
      <>
        <H1>{fmt(d0 ? c.titleManyD0 : c.titleMany, { count })}</H1>
        <P>{fmt(d0 ? c.introManyD0 : c.introMany, { name: d.name ?? c.nameFallback, date: localDateLong(d.date) })}</P>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ margin: '6px 0 20px', borderCollapse: 'collapse' }}><tbody>
          {events.map((it) => (
            <tr key={it.eventId}><td style={td}>
              <table role="presentation" cellPadding={0} cellSpacing={0} border={0} width="100%"><tbody><tr>
                <td width={64} valign="top" style={{ fontFamily: sans, fontSize: 14, fontWeight: 700, color: '#3F3579' }}>{hourOf(it, d.timezone)}</td>
                <td valign="top">
                  <div style={{ fontFamily: sans, fontSize: 16, fontWeight: 700, color: '#1A1533' }}>{it.title}</div>
                  {it.location && <div style={{ fontFamily: sans, fontSize: 13.5, color: '#5F5B7A' }}>{it.location}</div>}
                </td>
                <td align="right" valign="top"><Chip tone={it.labelColor}>{it.labelName}</Chip></td>
              </tr></tbody></table>
            </td></tr>
          ))}
        </tbody></table>
        <Button href={d.calendarUrl}>{c.cta}</Button>
      </>
    ),
  };
}

function inactivity(d: D<'inactivity'>, links: EmailLinks): Parts {
  const i = s.inactivity;
  const minutes = SHORT_SESSION_MINUTES;
  return {
    subject: fmt(i.subject, { days: d.days }),
    preheader: pl(i.preheader, d.dueCards, { minutes, cards: d.dueCards }),
    body: (
      <>
        <H1>{d.name ? fmt(i.title, { name: d.name }) : i.titleNoName}</H1>
        <P>{fmt(i.body, { days: d.days })}</P>
        <Stats items={[
          { value: d.dueCards, label: pl(i.statCards, d.dueCards) },
          { value: d.maps, label: pl(i.statMaps, d.maps) },
          { value: fmt(i.statMinutes, { minutes }), label: i.statMinutesLabel },
        ]} />
        {d.nextEvent && <P size={15}>{i.next} <b>{fmt(i.nextAt, { title: d.nextEvent.title, date: dateLong(d.nextEvent.startsAt, d.timezone) })}</b>.</P>}
        <Button href={d.resumeUrl}>{fmt(i.resume, { minutes })}</Button>
        {links.pauseUrl && (<><Spacer h={6} /><Button href={links.pauseUrl} variant="secondary">{i.pause}</Button></>)}
        <Note last>{i.once}</Note>
      </>
    ),
  };
}

function reviewReminder(d: D<'review-reminder'>): Parts {
  const r = s.review;
  return {
    subject: pl(r.subject, d.cards, { cards: d.cards }),
    preheader: fmt(r.preheader, { minutes: d.minutes }),
    body: (
      <>
        <Eyebrow>{r.eyebrow}</Eyebrow>
        <BigNumber value={d.cards} />
        <Subhead>{pl(r.big, d.cards)}</Subhead>
        <P>{fmt(r.detail, { due: pl(r.due, d.overdue), new: pl(r.new, d.newCards), minutes: d.minutes })}</P>
        {d.maps.length > 0 && <Rows rows={d.maps.map((m) => [m.title, pl(r.mapCards, m.cards)])} />}
        <Button href={d.reviewUrl}>{r.cta}</Button>
        <Note last>{r.note}</Note>
      </>
    ),
  };
}

function mapReady(d: D<'map-ready'>): Parts {
  const m = s.mapReady;
  return {
    subject: fmt(m.subject, { map: d.mapTitle }),
    preheader: fmt(m.preheader, { cards: pl(m.cardsN, d.cards), connections: pl(m.connectionsN, d.connections) }),
    body: (
      <>
        <H1>{fmt(m.title, { map: d.mapTitle })}</H1>
        <P>{fmt(m.body, { source: m.origin[d.origin] })}</P>
        <MapBand />
        <Stats items={[{ value: d.cards, label: pl(m.cards, d.cards) }, { value: d.connections, label: pl(m.connections, d.connections) }]} />
        <Button href={d.mapUrl}>{m.cta}</Button>
        <Spacer h={12} />
        <Callout tone="amber"><b>{m.warnBold}</b>{m.warn}</Callout>
      </>
    ),
  };
}

function waitlist(d: D<'waitlist-confirm'>): Parts {
  const w = s.waitlist;
  const sell = d.version === 'vender';
  const steps = sell ? [...w.stepsBuy, w.stepSell] : w.stepsBuy;
  return {
    subject: w.subject,
    preheader: w.preheader,
    body: (
      <>
        <H1>{w.title}</H1>
        <P>{d.name ? fmt(w.body, { name: d.name }) : w.bodyNoName}</P>
        <div style={{ margin: '0 0 22px' }}>
          <Chip tone="purple">{w.chipBuy}</Chip>
          {sell && (<>{' '}<Chip tone="amber">{d.sellerRole ? fmt(w.chipSell, { profile: w.roles[d.sellerRole] }) : w.chipSellNoProfile}</Chip></>)}
        </div>
        <Eyebrow>{w.whatNow}</Eyebrow>
        <Steps items={steps} />
        <Button href={d.storeUrl} variant="secondary">{w.cta}</Button>
        <Spacer h={10} />
        <P size={14}>{w.meanwhile}</P>
      </>
    ),
  };
}

/** Short notices (CCR-035): title, greeting + body, one button. */
const simple = (o: { subject: string; preheader: string; title: string; name?: string | null; body: string; cta?: [string, string]; extra?: ReactNode; footer?: Partial<FooterProps> }): Parts => ({
  subject: o.subject,
  preheader: o.preheader,
  footer: o.footer,
  body: (
    <>
      <H1>{o.title}</H1>
      <P>{o.name === undefined ? o.body : `${hi(o.name)} ${o.body}`}</P>
      {o.extra}
      {o.cta && <Button href={o.cta[1]}>{o.cta[0]}</Button>}
    </>
  ),
});

function supportReply(d: D<'support-reply'>): Parts {
  const t = s.support;
  const got = d.version === 'received';
  const number = d.ticketNumber;
  return simple({
    subject: fmt(got ? t.subjectReceived : t.subjectAnswered, { number }),
    preheader: got ? t.preheaderReceived : t.preheaderAnswered,
    title: fmt(got ? t.titleReceived : t.titleAnswered, { number }),
    name: d.name,
    body: got ? t.bodyReceived : t.bodyAnswered,
    cta: [got ? t.ctaReceived : t.ctaAnswered, d.ticketUrl],
    footer: { reason: t.reason },
  });
}

function referralReward(d: D<'referral-reward'>): Parts {
  const r = s.referralReward;
  const referrer = d.version === 'referrer';
  return simple({
    subject: r.subject,
    preheader: r.preheader,
    title: referrer ? fmt(r.titleReferrer, { friend: d.friendName ?? r.friendFallback }) : r.titleReferee,
    name: d.name,
    body: referrer ? r.bodyReferrer : fmt(r.bodyReferee, { friend: d.friendName ?? r.friendFallbackLower }),
    cta: [r.cta, d.dashboardUrl],
    footer: { reason: r.reason },
  });
}

function trialEnding(d: D<'trial-ending'>): Parts {
  const r = s.trialEnding;
  const last = d.version === 'd0';
  return simple({
    subject: last ? r.subjectD0 : r.subjectD3,
    preheader: last ? r.preheaderD0 : r.preheaderD3,
    title: last ? r.titleD0 : r.titleD3,
    name: d.name,
    body: fmt(r.body, { date: dateTime(d.endsAt, d.timezone) }),
    cta: [r.cta, d.plansUrl],
    footer: { reason: r.reason },
  });
}

function referralInvite(d: D<'referral-invite'>): Parts {
  const r = s.referralInvite;
  return simple({
    subject: fmt(r.subject, { referrer: d.referrerName }),
    preheader: r.preheader,
    title: fmt(r.title, { referrer: d.referrerName }),
    body: r.body,
    cta: [r.cta, d.inviteUrl],
    footer: { reason: r.reason, stopLabel: r.stop },
  });
}

function passwordChanged(d: D<'password-changed'>): Parts {
  const p = s.passwordChanged;
  return simple({
    subject: p.subject,
    preheader: p.preheader,
    title: p.title,
    name: d.name,
    body: fmt(p.body, { date: dateTime(d.changedAt, d.timezone) }),
    extra: <Callout tone="amber"><b>{p.notYouBold}</b>{p.notYou}</Callout>,
    cta: [p.cta, d.resetUrl],
  });
}

function welcome(d: D<'welcome'>): Parts {
  const w = s.welcome;
  return simple({ subject: w.subject, preheader: w.preheader, title: d.name ? fmt(w.title, { name: d.name }) : w.titleNoName, body: w.body, cta: [w.cta, d.startUrl] });
}

function onboardingNudge(d: D<'onboarding-nudge'>): Parts {
  const o = s.onboardingNudge;
  const first = d.version === 'first_map';
  return simple({
    subject: first ? o.subjectFirstMap : o.subjectDay3,
    preheader: first ? o.preheaderFirstMap : o.preheaderDay3,
    title: first ? o.titleFirstMap : o.titleDay3,
    name: d.name,
    body: first ? o.bodyFirstMap : o.bodyDay3,
    cta: [first ? o.ctaFirstMap : o.ctaDay3, d.actionUrl],
  });
}

function paymentReceipt(d: D<'payment-receipt'>): Parts {
  const p = s.paymentReceipt;
  return simple({ subject: p.subject, preheader: p.preheader, title: p.title, name: d.name, body: p.body, cta: [p.cta, d.receiptUrl], footer: { reason: p.reason } });
}

function adminAlert(d: D<'admin-alert'>): Parts {
  const a = s.adminAlert;
  const what = pl(d.version === 'export_users' ? a.users : a.payments, d.count);
  return simple({
    subject: a.subject,
    preheader: a.preheader,
    title: a.title,
    name: d.name,
    body: fmt(a.body, { what, date: dateTime(d.at, d.timezone) }),
    cta: [a.cta, d.auditUrl],
    footer: { reason: a.reason },
  });
}

function disputeResolved(d: D<'dispute-resolved'>, links: EmailLinks): Parts {
  const x = s.disputeResolved;
  return simple({ subject: x.subject, preheader: x.preheader, title: x.title, name: d.name, body: x.body, cta: [x.cta, links.appUrl] });
}

function landingWaitlist(): Parts {
  const l = s.landingWaitlist;
  return simple({ subject: l.subject, preheader: l.preheader, title: l.title, body: l.body, extra: <Note last>{l.notYou}</Note>, footer: { reason: l.reason } });
}

function parts<T extends EmailTemplate>(template: T, data: EmailData<T>, links: EmailLinks): Parts {
  // ponytail: one cast per call; the public signature pairs template and data.
  const d = data as never;
  switch (template) {
    case 'account-confirm': return accountConfirm(d);
    case 'purchase-success': return purchase(d, links);
    case 'password-reset': return passwordReset(d);
    case 'calendar-reminder': {
      const cd = data as D<'calendar-reminder'>;
      return cd.version === 'varios' ? calendarMany(cd) : calendarSingle(cd);
    }
    case 'inactivity': return inactivity(d, links);
    case 'review-reminder': return reviewReminder(d);
    case 'map-ready': return mapReady(d);
    case 'waitlist-confirm': return waitlist(d);
    case 'support-reply': return supportReply(d);
    case 'referral-reward': return referralReward(d);
    case 'referral-invite': return referralInvite(d);
    case 'trial-ending': return trialEnding(d);
    case 'password-changed': return passwordChanged(d);
    case 'welcome': return welcome(d);
    case 'onboarding-nudge': return onboardingNudge(d);
    case 'payment-receipt': return paymentReceipt(d);
    case 'admin-alert': return adminAlert(d);
    case 'dispute-resolved': return disputeResolved(d, links);
    case 'landing-waitlist': return landingWaitlist();
    default: throw new Error(`unknown template: ${String(template)}`);
  }
}

export function build<T extends EmailTemplate>(template: T, data: EmailData<T>, links: EmailLinks): Built {
  const kind: EmailClass = EMAIL_CLASS[template];
  const p = parts(template, data, links);
  return { ...p, footer: { kind, preferencesUrl: links.preferencesUrl, unsubscribeUrl: links.unsubscribeUrl, legal: links.legal, ...p.footer } };
}
