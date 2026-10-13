/** Shared guard for F33 integration tests: DATABASE_URL must be a local DB whose name contains `f33_test`. */
export function assertF33TestDb(url: string | undefined): void {
  if (!url) return;
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname) || !u.pathname.slice(1).includes("f33_test"))
    throw Error("Requires isolated local f33_test database");
}
