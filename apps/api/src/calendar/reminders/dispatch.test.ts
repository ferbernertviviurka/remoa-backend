// Synthetic DB and provider: real notify() failure outcomes through the dispatcher.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailData, Notify, NotifyEmailOutcome } from '@remoa/contracts';
import { emailExamples } from '@remoa/contracts/mocks';
const m = vi.hoisted(() => ({ execute: vi.fn(), txExecute: vi.fn(), deliver: vi.fn() }));
vi.mock('../../db', () => ({
  dbm: async () => ({ db: { execute: m.execute, transaction: (fn: (tx: unknown) => unknown) => fn({ execute: m.txExecute }) } }),
  uuids: (ids: string[]) => ids,
  run: (_id: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../../review/queue', () => ({ dayWindow: async () => ({}), dueByOffset: async () => [0] }));
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => undefined) }));
vi.mock('../ics', () => ({ coverUrlFor: () => null, icsUrlFor: () => 'https://example.test/event.ics' }));
vi.mock('@remoa/config', () => ({ env: () => ({ appUrl: 'https://example.test' }) }));
vi.mock('../../emails/send', () => ({ deliverEmail: m.deliver }));
import { dispatchDueReminders } from './dispatch';
import { notify } from '../../notifications/notify';
const now = new Date('2026-10-12T09:35:00Z');
const due = [{
  id: '00000000-0000-4000-8000-000000000001', event_id: '00000000-0000-4000-8000-000000000002',
  title: 'Compromisso de teste', starts_at: '2026-10-12T10:30:00Z', ends_at: null,
  all_day: false, location: null, description: null, label_name: 'Pessoal', label_color: 'orange',
  tz: 'America/Sao_Paulo', name: 'Teste', has_cover: false,
}];
const group = { user_id: '00000000-0000-4000-8000-000000000003', kind: 'd0', occurrence_date: '2026-10-12' };
const result = (rows: unknown[] = []) => Object.assign(rows, { count: rows.length });
function queueDispatch() {
  m.execute.mockResolvedValueOnce(result()).mockResolvedValueOnce(result()).mockResolvedValueOnce([group]);
  m.txExecute.mockResolvedValueOnce(due).mockResolvedValueOnce(result());
}
function queueNotify() {
  m.execute.mockResolvedValueOnce([{ email: 'synthetic@example.test', paused: false, in_app: true, email_pref: true }])
    .mockResolvedValueOnce([{ id: 'notice-id' }]);
}
beforeEach(() => { vi.resetAllMocks(); });
describe('real notify outcome regressions', () => {
  const payload = {
    reference: 'synthetic-calendar',
    data: { eventId: due[0]!.event_id, title: due[0]!.title, startsAt: due[0]!.starts_at, allDay: false, location: null },
    email: emailExamples.find((e) => e.template === 'calendar-reminder' && e.version === 'd0')!.data as EmailData<'calendar-reminder'>,
  };
  it('returns failed for an exception after creating the in-app notice', async () => {
    queueNotify();
    m.deliver.mockRejectedValueOnce(new Error('delivery unavailable'));
    await expect(notify(group.user_id, 'calendar_d0', payload)).resolves.toMatchObject({ inApp: 'created', email: 'failed' });
  });
  it('returns failed for a duplicate queued claim and duplicate for a completed one', async () => {
    queueNotify();
    m.deliver.mockResolvedValueOnce({ status: 'queued', duplicate: true, deliveryId: 'delivery-id' });
    await expect(notify(group.user_id, 'calendar_d0', payload)).resolves.toMatchObject({ email: 'failed' });
    queueNotify();
    m.deliver.mockResolvedValueOnce({ status: 'sent', duplicate: true, deliveryId: 'delivery-id' });
    await expect(notify(group.user_id, 'calendar_d0', payload)).resolves.toMatchObject({ email: 'duplicate' });
  });
});
describe('calendar dispatch failure outcomes', () => {
  it('retries the same reference when real notify catches an infrastructure error', async () => {
    queueDispatch(); queueNotify();
    m.deliver.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(dispatchDueReminders(now, notify)).rejects.toThrow('1 of 1 sends failed');
    expect(m.txExecute).toHaveBeenCalledTimes(1);
    const firstReference = m.deliver.mock.calls[0]![0].reference;
    m.txExecute.mockReset();
    queueDispatch(); queueNotify();
    m.deliver.mockResolvedValueOnce({ status: 'sent', deliveryId: 'delivery-id' });
    await expect(dispatchDueReminders(now, notify)).resolves.toMatchObject({ sent: 1 });
    expect(m.deliver.mock.calls[1]![0].reference).toBe(firstReference);
    expect(m.txExecute).toHaveBeenCalledTimes(2);
  });
  it('also retries a provider failure returned as an outcome', async () => {
    queueDispatch(); queueNotify();
    m.deliver.mockResolvedValueOnce({ status: 'failed', deliveryId: 'failed-delivery' });
    await expect(dispatchDueReminders(now, notify)).rejects.toThrow('sends failed');
    expect(m.txExecute).toHaveBeenCalledTimes(1);
  });
  it('keeps an existing queued delivery retryable until the stale claim can recover', async () => {
    queueDispatch(); queueNotify();
    m.deliver.mockResolvedValueOnce({ status: 'queued', duplicate: true, deliveryId: 'pending-delivery' });
    await expect(dispatchDueReminders(now, notify)).rejects.toThrow('sends failed');
    expect(m.txExecute).toHaveBeenCalledTimes(1);
  });
  it.each(['disabled', 'paused', 'capped', 'suppressed', 'duplicate'] as NotifyEmailOutcome[])
    ('respects the terminal %s outcome', async (email) => {
      queueDispatch();
      const fake: Notify = async () => ({ inApp: 'created', notificationId: null, email, emailDeliveryId: null });
      await expect(dispatchDueReminders(now, fake)).resolves.toMatchObject({ sent: 1 });
      expect(m.txExecute).toHaveBeenCalledTimes(2);
    });
});
