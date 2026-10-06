// G19 F27 FR-45/46 (D-913, P-401): legal acceptance. The versions come from the server's LEGAL_*_VERSION, never trusted from the client.
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { env } from '@remoa/config';
import { err, errorHttpStatus, legalAcceptInputSchema, ok, parseWith, type HttpErrorBody, type LegalStatus, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { dbm } from '../db';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

export async function legalStatus(userId: string): Promise<LegalStatus> {
  const { db, profiles } = await dbm();
  const [p] = await db.select({ t: profiles.termsAcceptedVersion, p: profiles.privacyAcceptedVersion, at: profiles.acceptedAt }).from(profiles).where(eq(profiles.userId, userId));
  const cur = env();
  return {
    termsVersion: cur.legalTermsVersion, privacyVersion: cur.legalPrivacyVersion, acceptedTermsVersion: p?.t ?? null, acceptedPrivacyVersion: p?.p ?? null, acceptedAt: p?.at ?? null,
    needsAcceptance: p?.t !== cur.legalTermsVersion || p?.p !== cur.legalPrivacyVersion,
  };
}

export const accountLegalRoutes = new Hono<Env>()
  .get('/legal', async (c) => send(ok(await legalStatus(c.get('userId')))))
  .post('/legal/accept', async (c) => {
    const body = parseWith(legalAcceptInputSchema, await c.req.json().catch(() => null));
    if (!body.ok) return send(body);
    const cur = env();
    if (body.data.termsVersion !== cur.legalTermsVersion || body.data.privacyVersion !== cur.legalPrivacyVersion) return send(err('validation', 'legal_version_mismatch'));
    const userId = c.get('userId');
    const { db, profiles, legalAcceptances } = await dbm();
    await db.transaction(async (tx) => {
      const at = new Date();
      await tx.update(profiles).set({ termsAcceptedVersion: cur.legalTermsVersion, privacyAcceptedVersion: cur.legalPrivacyVersion, acceptedAt: at }).where(eq(profiles.userId, userId));
      await tx.insert(legalAcceptances).values([
        { userId, document: 'terms', version: cur.legalTermsVersion, acceptedAt: at },
        { userId, document: 'privacy', version: cur.legalPrivacyVersion, acceptedAt: at },
      ]).onConflictDoNothing();
    });
    return send(ok(await legalStatus(userId)));
  });
