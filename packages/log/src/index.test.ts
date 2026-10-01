import { afterEach, expect, it, vi } from 'vitest';
import { createLogger, newRequestId } from './index';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
});

it('writes a JSON line with requestId', () => {
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  createLogger({ requestId: 'r1' }).info('oi', { a: 1 });
  const line = JSON.parse(String(out.mock.calls[0]?.[0]));
  expect(line).toMatchObject({ level: 'info', requestId: 'r1', msg: 'oi', a: 1 });
});

it('errors go to stderr and LOG_LEVEL filters', () => {
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.env.LOG_LEVEL = 'warn';
  const log = createLogger({ requestId: 'r2' });
  log.info('x');
  log.error('y');
  expect(out).not.toHaveBeenCalled();
  expect(err).toHaveBeenCalledOnce();
});

it('newRequestId is unique', () => {
  expect(newRequestId()).not.toBe(newRequestId());
});
