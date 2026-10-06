// G22: live scripts (smoke, eval) share one day budget across runs: the in-memory counter resets per process, so the count of
// today's real calls is kept in a git-ignored file. The OpenRouter free tier allows 50/day per account; scripts stop at 40.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiUsage, seedUsage } from '../src/client';

export const DAY_BUDGET = 40;
const file = join(dirname(fileURLToPath(import.meta.url)), '../node_modules/.cache/remoa-ai-usage.json');

/** Loads today's count into the client counter. */
export function loadBudget() {
  const today = new Date().toISOString().slice(0, 10);
  let count = 0;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { day?: string; count?: number };
    if (saved.day === today) count = saved.count ?? 0;
  } catch {
    /* first run today */
  }
  seedUsage(today, count);
  return count;
}

export function saveBudget() {
  const u = aiUsage();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ day: u.utcDay, count: u.day }));
}

export const budgetLeft = () => DAY_BUDGET - aiUsage().day;
