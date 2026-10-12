/** D-1805 durable-object check with a fake storage: HEAD/GET of the existing object only, no network. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../storage/storage', () => ({ getBytes: vi.fn(), headObject: vi.fn() }));
import { checkDurableObject, requestHash, type DurableRow } from './operations';
import { receiptHash, RECEIPT_MAX_BYTES } from '../../questions/generation/receipts';

const owner = randomUUID(), runId = randomUUID();
const store = (objects: Record<string, Buffer>, size?: number) => ({
  head: vi.fn(async (k: string) => (objects[k] ? { size: size ?? objects[k]!.length } : null)),
  get: vi.fn(async (k: string) => { if (!objects[k]) throw Error('missing'); return objects[k]!; }),
});
const receiptKey = `questions/generation/${owner}/${runId}/receipt.json`;
const receipt = (o: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ version: 2, runId, meta: { ownerId: owner }, envelope: {}, ...o }));
const row = (o: Partial<DurableRow> = {}): DurableRow => ({ target: 'question-receipt', payloadReference: receiptKey, runId, ownerId: owner, payloadHash: null, ...o });

describe('checkDurableObject', () => {
  it('accepts a matching receipt (with or without the run hash recorded yet)', async () => {
    const bytes = receipt();
    expect(await checkDurableObject(row(), store({ [receiptKey]: bytes }))).toBe('ok');
    expect(await checkDurableObject(row({ payloadHash: receiptHash(bytes) }), store({ [receiptKey]: bytes }))).toBe('ok');
  });
  it('rejects missing, oversized, foreign, hash-changed or malformed objects', async () => {
    expect(await checkDurableObject(row(), store({}))).toBe('durable_content_missing');
    expect(await checkDurableObject(row(), store({ [receiptKey]: receipt() }, RECEIPT_MAX_BYTES + 1))).toBe('replay_metadata_invalid');
    expect(await checkDurableObject(row({ payloadReference: `questions/generation/${randomUUID()}/${runId}/receipt.json` }), store({}))).toBe('replay_metadata_invalid');
    expect(await checkDurableObject(row({ payloadReference: `questions/generation/${owner}/../x/receipt.json` }), store({}))).toBe('replay_metadata_invalid');
    expect(await checkDurableObject(row({ payloadHash: 'a'.repeat(64) }), store({ [receiptKey]: receipt() }))).toBe('replay_metadata_invalid');
    expect(await checkDurableObject(row(), store({ [receiptKey]: receipt({ runId: randomUUID() }) }))).toBe('replay_metadata_invalid');
    expect(await checkDurableObject(row(), store({ [receiptKey]: Buffer.from('not json') }))).toBe('replay_metadata_invalid');
    expect(await checkDurableObject(row({ target: 'question-promotion-discovery' }), store({ [receiptKey]: receipt() }))).toBe('replay_metadata_invalid');
  });
  it('promotion: reference hash must match and every row must belong to the owner', async () => {
    const key = `questions/generation/${owner}/${runId}/promotion.json`;
    const plan = Buffer.from(JSON.stringify({ ownerId: owner, runIds: [runId], rows: [] }));
    const p = (ref: string) => row({ target: 'question-promotion', payloadReference: ref });
    expect(await checkDurableObject(p(`${key}#${receiptHash(plan)}`), store({ [key]: plan }))).toBe('ok');
    expect(await checkDurableObject(p(key), store({ [key]: plan }))).toBe('replay_metadata_invalid');
    expect(await checkDurableObject(p(`${key}#${'b'.repeat(64)}`), store({ [key]: plan }))).toBe('replay_metadata_invalid');
    const foreign = Buffer.from(JSON.stringify({ ownerId: randomUUID(), runIds: [runId], rows: [] }));
    expect(await checkDurableObject(p(`${key}#${receiptHash(foreign)}`), store({ [key]: foreign }))).toBe('replay_metadata_invalid');
  });
});

describe('request hash, worker claim', () => {
  it('request hash is stable for identical payloads and changes otherwise', () => {
    expect(requestHash({ a: 1 })).toBe(requestHash({ a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
  it('worker claims receipt/promotion by attempt_limit; discovery keeps its own rule', () => {
    const src = readFileSync(new URL('../../questions/generation/reconcile.ts', import.meta.url), 'utf8');
    expect(src).toContain("target IN ('question-receipt','question-promotion') AND delivered_at IS NULL AND attempts<attempt_limit");
    expect(src).not.toMatch(/attempts<20/);
  });
});
