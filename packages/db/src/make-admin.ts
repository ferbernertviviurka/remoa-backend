// F19 (D-421, D-430): the only way to create an admin. `pnpm db:make-admin <email>` — never a screen or a route.
import postgres from 'postgres';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error('usage: pnpm db:make-admin <email>');
const sql = postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', { max: 1 });
try {
  await sql.begin(async (tx) => {
    const [row] = await tx`
      update public.profiles p set role = 'admin', updated_at = now() from auth.users u
      where u.id = p.user_id and lower(u.email) = ${email}
      returning p.user_id, (select role from public.profiles where user_id = p.user_id) as before`;
    if (!row) throw new Error(`no profile for ${email}`);
    await tx`insert into public.admin_audit_log (actor_type, action, target_type, target_id, reason, result, before, after)
      values ('system', 'user.make_admin', 'user', ${row.user_id}, 'pnpm db:make-admin', 'success',
              ${tx.json({ role: row.before })}, ${tx.json({ role: 'admin' })})`;
    process.stdout.write(`${email} is now admin (${row.user_id})\n`);
  });
} finally {
  await sql.end();
}
