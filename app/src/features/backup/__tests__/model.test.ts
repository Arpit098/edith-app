import { localEvent } from '../../../core/events';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createBackupModel, pillText } from '../model';

const ACTIVE = { mode: 'auto', active: true, reason: 'usage_limit', resets: 1793370600, provider: 'Nemotron', queued: 2, providers: [] };

describe('backup model', () => {
  it('follows backup.changed and resyncs on connect', async () => {
    const ctx = fakeContext();
    ctx.transport.on('GET /v1/backup', { ...ACTIVE, active: false });
    const m = createBackupModel(ctx.bus, ctx.api);
    expect(m.store.get()).toBeNull();
    ctx.bus.publish(ev('backup.changed', ACTIVE));
    expect(m.store.get()?.active).toBe(true);
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(m.store.get()?.active).toBe(false);
    m.dispose();
  });

  it('keeps what it has when the server has no backup feature', async () => {
    const ctx = fakeContext();
    const m = createBackupModel(ctx.bus, ctx.api);
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    expect(m.store.get()).toBeNull();
  });

  it('says who answers and until when, in IST', () => {
    expect(pillText(null)).toBeNull();
    expect(pillText({ ...ACTIVE, active: false } as never)).toBeNull();
    expect(pillText(ACTIVE as never)).toBe('Backup AI (Nemotron) is answering, read-only · Claude back ~20:00 IST · 2 queued for Claude');
    expect(pillText({ ...ACTIVE, reason: 'manual', provider: null, queued: 0 } as never)).toBe('Backup AI is answering, read-only · turned on with /backup on');
  });
});
