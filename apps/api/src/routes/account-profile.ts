import { Hono } from 'hono';
import {
  errorHttpStatus, identityProviderSchema, parseWith, requestEmailChangeInputSchema, updatePreferencesInputSchema, updateProfileInputSchema,
  err, type HttpErrorBody, type Result,
} from '@remoa/contracts';
import type { Env } from '../app';
import { authInfoOf, loadAuthUser } from '../account/auth-admin';
import { cancelEmailChange, requestEmailChange, resendEmailChange } from '../account/email';
import { unlinkIdentity } from '../account/identities';
import { updatePreferences } from '../account/preferences';
import { cancelDeletion, getAccount, updateProfile } from '../account/profile';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);

/** F13. Mounted at /v1/account next to the F08 export/delete routes. */
export const accountProfileRoutes = () =>
  new Hono<Env>()
    .get('/me', async (c) => {
      // D-1094: the Auth read and the database reads in parallel (getAccount waits for `auth` only at the end)
      const user = loadAuthUser(c.get('userId'));
      user.catch(() => undefined);
      const data = getAccount(c.get('userId'), user.then((u) => (u ? authInfoOf(u) : null)));
      data.catch(() => undefined);
      return (await user) ? send({ ok: true, data: (await data)! }) : send(err('not_found', 'user not found'));
    })
    .patch('/profile', async (c) => {
      const i = parseWith(updateProfileInputSchema, await body(c));
      return send(i.ok ? await updateProfile(c.get('userId'), i.data) : i);
    })
    .post('/email', async (c) => {
      const i = parseWith(requestEmailChangeInputSchema, await body(c));
      return send(i.ok ? await requestEmailChange(c.get('userId'), i.data) : i);
    })
    .post('/email/resend', async (c) => send(await resendEmailChange(c.get('userId'))))
    .delete('/email', async (c) => send(await cancelEmailChange(c.get('userId'))))
    .delete('/identities/:provider', async (c) => {
      const p = identityProviderSchema.safeParse(c.req.param('provider'));
      return send(p.success ? await unlinkIdentity(c.get('userId'), p.data) : err('validation', 'unknown provider'));
    })
    .patch('/preferences', async (c) => {
      const i = parseWith(updatePreferencesInputSchema, await body(c));
      return send(i.ok ? await updatePreferences(c.get('userId'), i.data) : i);
    })
    .post('/deletion/cancel', async (c) => send(await cancelDeletion(c.get('userId'))));
