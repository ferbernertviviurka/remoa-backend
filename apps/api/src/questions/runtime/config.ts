export type QuestionFeature = "import" | "catalog" | "sessions";
const keys = {
  import: "QUESTIONS_IMPORT_ENABLED",
  catalog: "QUESTIONS_CATALOG_ENABLED",
  sessions: "QUESTIONS_SESSIONS_ENABLED",
} as const;
/** Import and sessions stay closed in production until set. The catalog stays available unless explicitly turned off. */
export function questionFeatures(env: NodeJS.ProcessEnv = process.env) {
  const dev = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  return Object.fromEntries(
    Object.entries(keys).map(([feature, key]) => {
      const raw = env[key];
      if (raw === undefined || raw === "") return [feature, feature === "catalog" || dev];
      if (!["0", "1", "true", "false"].includes(raw))
        throw Error(`invalid ${key}: expected 0 or 1`);
      return [feature, raw === "1" || raw === "true"];
    }),
  ) as Record<QuestionFeature, boolean>;
}
export type AdmissionKind = "upload" | "import" | "session" | "report";
export function questionAdmissionLimits(env: NodeJS.ProcessEnv = process.env) {
  const defaults = { upload: 5, import: 3, session: 20, report: 5 };
  return Object.fromEntries(
    Object.entries(defaults).map(([kind, count]) => {
      const key = `QUESTIONS_RATE_${kind.toUpperCase()}`,
        raw = env[key],
        limit = raw === undefined ? count : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw Error(`invalid ${key}: expected integer 1..1000`);
      return [kind, limit];
    }),
  ) as Record<AdmissionKind, number>;
}
