// G18 F24: `pnpm emails:check` and `pnpm emails:test <template> <destinatário> [versão]` (repo root). Runbook: ../docs/runbooks/emails.md.
// check: validates the .env (parseEnv), prints provider / sender / domain (never a secret) and, with RESEND_API_KEY, asks Resend whether
// EMAIL_DOMAIN is verified with open and click tracking off. test: sends one sample through sendEmail; with resend it refuses to send
// before the domain is ready (goal rule: no real e-mail before emails:check passes).
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { EnvError, parseEnv, addressOf, type Env } from '@remoa/config';
import { EMAIL_CLASS, emailTemplateSchema, type EmailTemplate } from '@remoa/contracts';
import { emailSamples, sampleData } from '@remoa/emails';

const out = (s = '') => process.stdout.write(`${s}\n`);

export type DomainInfo = { name: string; found: boolean; status?: string; region?: string; openTracking?: boolean; clickTracking?: boolean };

/** What still blocks real sending; [] = ready. */
export function domainProblems(d: DomainInfo): string[] {
  if (!d.found) return [`domínio ${d.name} não está cadastrado no Resend`];
  const p: string[] = [];
  if (d.status !== 'verified') p.push(`domínio ${d.name} não verificado (status: ${d.status ?? '?'}); confira SPF e DKIM no DNS`);
  if (d.openTracking !== false) p.push('rastreio de abertura ligado (ou desconhecido): desligue em Domains › Configuration');
  if (d.clickTracking !== false) p.push('rastreio de clique ligado (ou desconhecido): desligue em Domains › Configuration');
  return p;
}

/** The sending domain: EMAIL_DOMAIN, else the domain of EMAIL_FROM. */
export const sendingDomain = (e: Env) => e.emailDomain ?? addressOf(e.emailFrom)?.split('@')[1]?.toLowerCase() ?? '';

async function lookupDomain(apiKey: string, name: string): Promise<DomainInfo> {
  const client = new Resend(apiKey);
  const list = await client.domains.list();
  if (list.error) throw new Error(`Resend GET /domains: ${list.error.name} ${list.error.message}`);
  const d = list.data?.data.find((x) => x.name.toLowerCase() === name);
  if (!d) return { name, found: false };
  const one = await client.domains.get(d.id);
  if (one.error || !one.data) throw new Error(`Resend GET /domains/${d.id}: ${one.error?.name ?? 'no data'}`);
  return { name, found: true, status: one.data.status, region: one.data.region, openTracking: one.data.open_tracking, clickTracking: one.data.click_tracking };
}

function loadEnv(): Env | null {
  try {
    process.loadEnvFile(new URL('../../../../.env', import.meta.url).pathname); // repo .env when present; production passes real env vars
  } catch {
    /* no .env file: use the process environment */
  }
  try {
    return parseEnv();
  } catch (e) {
    if (e instanceof EnvError) {
      out('✗ .env inválido:');
      for (const p of e.problems) out(`  - ${p}`);
      return null;
    }
    throw e;
  }
}

/** 0 = ready (or console in development); 1 = something to fix. */
async function check(): Promise<number> {
  const e = loadEnv();
  if (!e) return 1;
  const domain = sendingDomain(e);
  const yes = (b: boolean) => (b ? 'sim' : 'não');
  out(`ambiente:        ${e.production ? 'produção' : 'desenvolvimento'}`);
  out(`provedor:        ${e.emailProvider}`);
  out(`remetente:       ${e.emailFrom}`);
  out(`responder para:  ${e.emailReplyTo}`);
  out(`domínio:         ${domain || '(nenhum)'}`);
  out(`links (APP_URL): ${e.appUrl}`);
  out(`API_ORIGIN:      ${e.apiOrigin}  (webhook: ${e.apiOrigin}/v1/emails/webhook · hook: ${e.apiOrigin}/v1/auth/send-email)`);
  out(`chave Resend:    ${yes(!!e.resendApiKey)} · segredo webhook: ${yes(!!e.resendWebhookSecret)} · segredo hook Supabase: ${yes(!!e.sendEmailHookSecret)}`);
  out(`redirecionar:    ${e.emailTestRedirect ? 'sim (EMAIL_TEST_REDIRECT: todo e-mail vai para um só endereço)' : 'não'}`);
  out(`rodapé legal:    ${yes(!!(e.emailFooterLegalName || e.emailFooterAddress))}`);
  if (!e.resendApiKey) {
    out(e.emailProvider === 'console' ? '\n✓ modo console: nada sai; os e-mails ficam em .emails/ e no log.' : '\n✗ EMAIL_PROVIDER=resend sem RESEND_API_KEY.');
    return e.emailProvider === 'console' ? 0 : 1;
  }
  if (!domain) {
    out('\n✗ defina EMAIL_DOMAIN (ou um EMAIL_FROM com domínio).');
    return 1;
  }
  const info = await lookupDomain(e.resendApiKey, domain);
  if (info.found) out(`Resend:          status ${info.status} · região ${info.region ?? '?'} · abertura ${info.openTracking ? 'ligado' : 'desligado'} · clique ${info.clickTracking ? 'ligado' : 'desligado'}`);
  const problems = domainProblems(info);
  if (problems.length) {
    out('\n✗ ainda não está pronto para envio real:');
    for (const p of problems) out(`  - ${p}`);
    return 1;
  }
  if (e.emailProvider !== 'resend') out('\n(o domínio está pronto; EMAIL_PROVIDER ainda é console)');
  out('\n✓ pronto para enviar.');
  return 0;
}

async function test(args: string[]): Promise<number> {
  const [rawTemplate, to, version = 'default'] = args;
  const usage = `uso: pnpm emails:test <template> <destinatário> [versão]\ntemplates: ${[...new Set(emailSamples.map((s) => s.template))].join(', ')}`;
  const t = emailTemplateSchema.safeParse(rawTemplate);
  if (!t.success || !to) {
    out(usage);
    return 1;
  }
  const template: EmailTemplate = t.data;
  const versions = emailSamples.filter((s) => s.template === template).map((s) => s.version);
  if (!versions.includes(version)) {
    out(`versões de ${template}: ${versions.join(', ')}`);
    return 1;
  }
  const e = loadEnv();
  if (!e) return 1;
  if (e.emailProvider === 'resend') {
    const domain = sendingDomain(e);
    const problems = domain && e.resendApiKey ? domainProblems(await lookupDomain(e.resendApiKey, domain)) : ['sem domínio ou chave'];
    if (problems.length) {
      out('✗ não envio: rode `pnpm emails:check` e resolva antes:');
      for (const p of problems) out(`  - ${p}`);
      return 1;
    }
  }
  const { dbm } = await import('../db');
  const { sendEmail } = await import('./send');
  // Reminder and list e-mails carry a per-account unsubscribe link: use the account with this address when there is one.
  let userId: string | null = null;
  if (EMAIL_CLASS[template] !== 'transactional') {
    const { db } = await dbm();
    const [u] = await db.execute<{ id: string }>(sql`select id from auth.users where lower(email) = lower(${to}) limit 1`);
    userId = u?.id ?? null;
    if (!userId && template !== 'referral-invite' && template !== 'landing-waitlist') {
      out(`✗ ${template} é ${EMAIL_CLASS[template]} e precisa de uma conta com o endereço ${to} (o link de descadastro é por conta).`);
      return 1;
    }
  }
  const r = await sendEmail({ template, to, data: sampleData(template, version), reference: `emails-test:${randomUUID()}`, userId });
  out(`${r.status === 'sent' ? '✓' : '✗'} ${template}/${version} → ${e.emailTestRedirect ? `${e.emailTestRedirect} (EMAIL_TEST_REDIRECT)` : to}: ${r.status}${'reason' in r ? ` (${r.reason})` : ''}`);
  if (e.emailProvider === 'console') out('  modo console: veja .emails/ na raiz do remoa-backend.');
  return r.status === 'sent' ? 0 : 1;
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = cmd === 'check' ? check() : cmd === 'test' ? test(rest) : Promise.resolve((out('uso: cli.ts check | test <template> <destinatário> [versão]'), 1));
  run.then((code) => process.exit(code), (err: unknown) => {
    out(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
