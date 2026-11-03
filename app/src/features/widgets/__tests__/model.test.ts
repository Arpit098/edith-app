import { localEvent } from '../../../core/events';
import type { HomeWidgets, WidgetSnapshot } from '../../../core/ports';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createWidgetsModel, lineOf, MAX_TEXT, REFRESH_S, withLine } from '../model';

/** Like the native module: the saved snapshot, with texts dropped while "Show message text" is off. */
class FakeWidgets implements HomeWidgets {
  saved: WidgetSnapshot | null = null;
  writes = 0;
  show = true;
  read() {
    return this.saved;
  }
  write(s: WidgetSnapshot) {
    this.writes++;
    this.saved = this.show ? s : redact(s);
  }
  showText() {
    return this.show;
  }
  setShowText(on: boolean) {
    this.show = on;
    if (!on && this.saved) this.saved = redact(this.saved);
  }
}

function redact(s: WidgetSnapshot): WidgetSnapshot {
  return { ...s, messages: s.messages.map((m) => ({ ...m, text: '' })), permission: s.permission && { ...s.permission, text: '' }, hidden: true };
}

function setup(widgets = new FakeWidgets()) {
  const ctx = fakeContext();
  let now = 1_800_000_100;
  const m = createWidgetsModel({ bus: ctx.bus, api: ctx.api, widgets, now: () => now });
  const emit = (e: ReturnType<typeof ev>) => ctx.bus.publish(e);
  return { ctx, widgets, m, emit, setNow: (t: number) => (now = t) };
}

const texts = (w: FakeWidgets) => w.saved?.messages.map((m) => m.text);

describe('lineOf', () => {
  it('turns replies, failures, approvals and reminders into one plain line each', () => {
    expect(lineOf(ev('turn.done', { ref: 'r1', text: '**Disk** is at `42%`', steps: 2, elapsed: 3 }))).toMatchObject({ key: 'turn:r1', text: 'Disk is at 42%', alert: false });
    expect(lineOf(ev('turn.done', { ref: 'r1', text: 'raw', display_text: 'shown' }))!.text).toBe('shown');
    expect(lineOf(ev('turn.done', { ref: 'r2', text: 'rate limited', is_error: true }))).toMatchObject({ text: '⚠️ rate limited', alert: true });
    expect(lineOf(ev('turn.failed', { ref: 'r3', reason: 'crashed', detail: 'boom' }))).toMatchObject({ key: 'turn:r3', text: "⚠️ EDITH couldn't finish: boom", alert: true });
    expect(lineOf(ev('permission.request', { id: 'p1', tool: 'Bash', detail: 'npm test' }))).toMatchObject({ key: 'perm:p1', text: '🔐 Approve Bash? npm test', alert: true });
    expect(lineOf(ev('reminder.due', { id: 'm1', text: 'call mum', due: 5, every: null, late: false }))).toMatchObject({ key: 'rem:m1:5', text: '⏰ call mum', alert: true });
    expect(lineOf(ev('message.assistant', { text: 'side answer', ref: 'r4', lane: 'side', cursor: 'c' }))).toMatchObject({ key: 'turn:r4', text: 'side answer' });
  });

  it('adds nothing for the main lane’s running commentary, progress or events without an id', () => {
    expect(lineOf(ev('message.assistant', { text: 'let me check', cursor: 'c', ref: 'r1' }))).toBeNull();
    expect(lineOf(ev('turn.progress', { ref: 'r1', lane: 'main', steps: 1, step: 'x', elapsed: 1 }))).toBeNull();
    expect(lineOf(ev('turn.done', { text: 'no ref' }))).toBeNull();
    expect(lineOf(ev('permission.request', { tool: 'Bash' }))).toBeNull();
  });

  it('cuts a long reply to the widget’s 300 characters', () => {
    const line = lineOf(ev('turn.done', { ref: 'r', text: 'x'.repeat(1000) }))!;
    expect(line.text).toHaveLength(MAX_TEXT);
    expect(line.text.endsWith('…')).toBe(true);
  });
});

describe('withLine', () => {
  it('keeps the newest three, newest first, placing a late arrival by its time', () => {
    const at = (ts: number, text = String(ts)) => ({ key: text, text, alert: false, ts });
    let list = withLine([], at(10));
    list = withLine(list, at(30));
    list = withLine(list, at(20));
    expect(list.map((m) => m.ts)).toEqual([30, 20, 10]);
    list = withLine(list, at(40));
    expect(list.map((m) => m.ts)).toEqual([40, 30, 20]);
    expect(withLine(list, at(5)).map((m) => m.ts)).toEqual([40, 30, 20]); // older than all three: not shown
  });
});

describe('createWidgetsModel', () => {
  it('writes each reply with the state: working while a turn runs, idle after', () => {
    const { widgets, emit } = setup();
    emit(ev('turn.started', { ref: 'r1' }));
    expect(widgets.saved).toMatchObject({ v: 1, state: 'working', messages: [], permission: null, hidden: false });
    emit(ev('turn.done', { ref: 'r1', text: 'Disk is fine', steps: 1, elapsed: 2 }));
    expect(widgets.saved).toMatchObject({ state: 'idle', messages: [{ text: 'Disk is fine', alert: false, ts: 1_800_000_000 }] });
    expect(widgets.saved!.at).toBe(1_800_000_100);
  });

  it('builds on what is saved (a push may have added to it), never on an old copy', () => {
    const { widgets, emit } = setup();
    emit(ev('turn.done', { ref: 'r1', text: 'one' }));
    // While the app was away, the native side folded a push in.
    widgets.saved = { ...widgets.saved!, messages: [{ text: '⏰ from a push', ts: 1_800_000_050, alert: true }, ...widgets.saved!.messages] };
    emit(ev('turn.done', { ref: 'r2', text: 'two' }, { ts: 1_800_000_060 }));
    expect(texts(widgets)).toEqual(['two', '⏰ from a push', 'one']);
  });

  it('waits on Arpit while an approval is open, with its id for Approve / Deny, and works on after it', () => {
    const { widgets, emit } = setup();
    emit(ev('turn.started', { ref: 'r1' }));
    emit(ev('permission.request', { id: 'p1', tool: 'Bash', detail: 'rm -rf build' }));
    expect(widgets.saved).toMatchObject({ state: 'waiting', permission: { id: 'p1', text: '🔐 Approve Bash? rm -rf build' } });
    expect(texts(widgets)).toEqual(['🔐 Approve Bash? rm -rf build']);
    emit(ev('permission.resolved', { id: 'p1', decision: 'allow' }));
    expect(widgets.saved).toMatchObject({ state: 'working', permission: null });
    expect(texts(widgets)).toEqual(['🔐 Approve Bash? rm -rf build']); // the line stays, as a push leaves it
  });

  it('writes a line once, however many events carry it (a side lane’s message, then its turn.done)', () => {
    const { widgets, emit } = setup();
    emit(ev('message.assistant', { text: 'side answer', ref: 's1', lane: 'side', cursor: 'c' }));
    emit(ev('turn.done', { ref: 's1', text: 'side answer', lane: 'side' }));
    emit(ev('permission.request', { id: 'p1', tool: 'Bash' }));
    emit(ev('permission.request', { id: 'p1', tool: 'Bash' }));
    expect(texts(widgets)).toEqual(['🔐 Approve Bash?', 'side answer']);
  });

  it('writes only when something shown changes', () => {
    const { widgets, emit } = setup();
    emit(ev('turn.started', { ref: 'r1' }));
    const writes = widgets.writes;
    emit(ev('turn.progress', { ref: 'r1', lane: 'main', steps: 1, step: '$ ls', elapsed: 1 }));
    emit(ev('lane.status', { main: 'busy', side: 0, queued: 0 }));
    emit(ev('turn.started', { ref: 'r1' }));
    emit(ev('tool.call', { id: 't', name: 'Bash', summary: '$ ls', cursor: 'c' }));
    expect(widgets.writes).toBe(writes);
  });

  it('a long turn’s progress refreshes the time now and then, so it never looks stale', () => {
    const { widgets, emit, setNow } = setup();
    emit(ev('turn.started', { ref: 'r1' }));
    const writes = widgets.writes;
    setNow(1_800_000_100 + REFRESH_S - 1);
    emit(ev('turn.progress', { ref: 'r1', lane: 'main', steps: 2, step: 'x', elapsed: 900 }));
    expect(widgets.writes).toBe(writes);
    setNow(1_800_000_100 + REFRESH_S);
    emit(ev('turn.progress', { ref: 'r1', lane: 'main', steps: 3, step: 'x', elapsed: 901 }));
    expect(widgets.writes).toBe(writes + 1);
    expect(widgets.saved).toMatchObject({ state: 'working', at: 1_800_000_100 + REFRESH_S });
  });

  it('lane.status idle drops runs whose end was missed', () => {
    const { widgets, emit } = setup();
    emit(ev('turn.started', { ref: 'r1' }));
    emit(ev('lane.status', { main: 'idle', side: 0, queued: 0 }));
    expect(widgets.saved!.state).toBe('idle');
    emit(ev('lane.status', { main: 'idle', side: 1, queued: 0 }));
    expect(widgets.saved!.state).toBe('working');
  });

  it('resyncs the state and the waiting approval on each connect', async () => {
    const { ctx, widgets } = setup();
    ctx.transport
      .on('GET /v1/status', { main: 'busy', queued: 0, runs: [{ ref: 'r9', lane: 'main', seconds: 4, step: null }], tmux: 'running', conversation: true, session: null })
      .on('GET /v1/permissions', { pending: [{ id: 'p7', tool: 'Edit', detail: 'a.ts', ref: 'r9', lane: 'main' }] });
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(widgets.saved).toMatchObject({ state: 'waiting', permission: { id: 'p7', text: '🔐 Approve Edit? a.ts' } });
    ctx.transport.on('GET /v1/permissions', { pending: [] });
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(widgets.saved).toMatchObject({ state: 'working', permission: null });
  });

  it('keeps the old state when the resync fails', async () => {
    const { ctx, widgets, emit } = setup();
    emit(ev('turn.started', { ref: 'r1' }));
    ctx.transport.on('GET /v1/status', () => {
      throw new Error('offline');
    });
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(widgets.saved!.state).toBe('working');
  });

  it('"Show message text in widgets": on by default; off is saved natively and wipes the texts', () => {
    const { widgets, emit, m } = setup();
    expect(m.store.get().showText).toBe(true);
    emit(ev('turn.done', { ref: 'r1', text: 'secret plans' }));
    m.setShowText(false);
    expect(widgets.show).toBe(false);
    expect(m.store.get().showText).toBe(false);
    expect(texts(widgets)).toEqual(['']);
    emit(ev('turn.done', { ref: 'r2', text: 'more secrets' }));
    expect(widgets.saved).toMatchObject({ hidden: true });
    expect(JSON.stringify(widgets.saved)).not.toContain('secret');
    m.setShowText(true);
    emit(ev('turn.done', { ref: 'r3', text: 'visible again' }));
    expect(widgets.saved).toMatchObject({ hidden: false });
    expect(texts(widgets)![0]).toBe('visible again');
  });

  it('starts from the setting the phone has saved', () => {
    const w = new FakeWidgets();
    w.show = false;
    expect(setup(w).m.store.get().showText).toBe(false);
  });

  it('stops listening on dispose', () => {
    const { widgets, emit, m } = setup();
    m.dispose();
    emit(ev('turn.done', { ref: 'r1', text: 'x' }));
    expect(widgets.writes).toBe(0);
  });
});
