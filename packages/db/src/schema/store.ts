// G16 store waitlist (CCR-030, D-650–D-659). RLS, grants and the `store_waitlist_role` check in migrations/0025_g16_store_waitlist.sql.
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { timestamps, userId } from './common';

/** One row per user (PK = upsert target). Opt-out = DELETE (D-653); account deletion cascades. Written only by the API connection. */
export const storeWaitlist = pgTable('store_waitlist', {
  userId: userId().primaryKey(),
  /** E-mail the user asked to be notified at (may differ from the account's). */
  email: text('email').notNull(),
  wantsBuy: boolean('wants_buy').notNull().default(false),
  wantsSell: boolean('wants_sell').notNull().default(false),
  /** storeSellerRoles: teacher | student_resident | physician; only when wants_sell. */
  sellerRole: text('seller_role'),
  consentedAt: timestamp('consented_at', { withTimezone: true }).notNull().default(sql`now()`),
  ...timestamps,
}, (t) => [
  index('store_waitlist_created_idx').on(t.createdAt.desc()),
  check('store_waitlist_interest', sql`${t.wantsBuy} or ${t.wantsSell}`),
  check('store_waitlist_role', sql`(${t.wantsSell} and ${t.sellerRole} in ('teacher', 'student_resident', 'physician')) or (not ${t.wantsSell} and ${t.sellerRole} is null)`),
  check('store_waitlist_email', sql`char_length(${t.email}) between 3 and 254`),
]);
