import { sql } from 'drizzle-orm';
import { dbm } from '../db';

/** First name for e-mail greetings, or null (the templates have a no-name greeting). */
export async function firstNameOf(userId: string): Promise<string | null> {
  const { db } = await dbm();
  const [r] = await db.execute<{ name: string | null }>(sql`select name from profiles where user_id = ${userId}`);
  return r?.name?.trim().split(/\s+/)[0]?.slice(0, 80) || null;
}
