import { createLogger } from '@remoa/log';

export type Email = { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> };

const log = createLogger({ requestId: 'mailer' });
const outbox: Email[] = [];
/** Dev/test outbox (no RESEND_API_KEY): read by tests. */
export const sentEmails = () => outbox;

/** Resend over fetch, no SDK. Without RESEND_API_KEY it logs (never the body) and keeps the message in memory. */
export async function sendEmail(mail: Email): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    outbox.push(mail);
    if (outbox.length > 200) outbox.shift(); // ponytail: in-memory dev outbox, capped
    log.info('email (not sent, no RESEND_API_KEY)', { subject: mail.subject });
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM ?? 'Remoa <no-reply@remoa.app>', to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html, headers: mail.headers }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}
