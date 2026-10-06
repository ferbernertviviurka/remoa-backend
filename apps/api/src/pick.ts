import { getTableColumns, type Table } from 'drizzle-orm';

/** G21 FR-17 (D-1066): explicit column list for `select(...)`, typed by key — no `select *`. */
export const pick = <T extends Table, K extends keyof T['_']['columns'] & string>(t: T, ...keys: K[]) => {
  const all = getTableColumns(t) as T['_']['columns'];
  return Object.fromEntries(keys.map((k) => [k, all[k]])) as Pick<T['_']['columns'], K>;
};
