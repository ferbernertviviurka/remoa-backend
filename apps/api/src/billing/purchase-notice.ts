// G18 F26/F24: "purchase" notice (in-app + e-mail) after a payment is confirmed. Amount, method and date come from the Stripe event
// (mirrored in `payments`); the next charge from the subscription row. Nothing here sets a price.
import { sql } from 'drizzle-orm';
import { env } from '@remoa/config';
import type { PaymentItem } from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import type { PaidNotice } from '../admin/payments/mirror';
import { dbm } from '../db';
import { notify } from '../notifications/notify';

const log = createLogger({ requestId: 'purchase-notice' });
/** Names of the three sellable items (product vocabulary; the backend does not import @remoa/strings). */
const PLAN_NAME: Record<PaymentItem, string> = { pro_monthly: 'Pro mensal', pro_annual: 'Pro anual', founder_lifetime: 'Founder' };

/** Reference = the payment id (pi_… / in_…): a renewal is a new payment, so it gets its own notice; a replay is a duplicate. Never throws. */
export async function notifyPurchase(n: PaidNotice): Promise<void> {
  try {
    const { db } = await dbm();
    const [r] = await db.execute<{ name: string | null; tz: string | null; renews_at: string | null }>(sql`
      select p.name, p.timezone as tz, s.renews_at from profiles p left join subscriptions s on s.user_id = p.user_id where p.user_id = ${n.userId}`);
    const planName = PLAN_NAME[n.item];
    await notify(n.userId, 'purchase', {
      reference: n.paymentId,
      href: '/app/conta/plano',
      data: { planName, orderId: n.paymentId },
      email: {
        name: r?.name?.trim().split(/\s+/)[0] || null,
        planName,
        amountCents: n.amountCents,
        currency: 'BRL',
        method: n.method,
        paidAt: n.paidAt,
        nextChargeAt: n.method === 'card' && r?.renews_at ? new Date(r.renews_at).toISOString() : null, // Pix and Founder have no next charge
        orderId: n.paymentId,
        manageUrl: `${env().appUrl}/app/conta/plano`,
        timezone: r?.tz ?? 'America/Sao_Paulo',
      },
    });
  } catch (e) {
    log.error('purchase notice failed', { error: e instanceof Error ? e.message : String(e) });
  }
}
