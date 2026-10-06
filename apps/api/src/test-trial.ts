// D-1213: the sign-up trigger (handle_new_user) gives every account the free Pro trial. Integration tests that model a Free
// account call this right after creating the user: that account has already used its trial.
import { sql } from 'drizzle-orm';

export async function dropTrial(...ids: string[]) {
  const { db } = await import('@remoa/db');
  await db.execute(sql`delete from entitlement_grants where source = 'trial' and user_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
}
