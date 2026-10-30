import { localEvent } from '../../../core/events';
import type { AppVisibility, LocalNotification, Notifier } from '../../../core/ports';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createNotifications, preview, SEEN_MAX } from '../model';

class FakeNotifier implements Notifier {
  posted: LocalNotification[] = [];
  cancelled: string[] = [];
  asked = 0;
  showing: string[] = []; // what Android shows from before a restart
  async active() {
    return this.showing;
  }
  post(n: LocalNotification) {
    this.posted.push(n);
  }
  cancel(tag: string) {
    this.cancelled.push(tag);
  }
  async ensurePermission() {
    this.asked++;
    return true;
  }
}

class FakeVisibility implements AppVisibility {
  on = false;
  private handlers = new Set<(active: boolean) => void>();
  active = () => this.on;
  onChange(h: (active: boolean) => void) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  set(on: boolean) {
    this.on = on;
    this.handlers.forEach((h) => h(on));
  }
}

function setup(showing: string[] = []) {
  const ctx = fakeContext();
  ctx.transport.configure({ baseUrl: 'http://edith:8787', token: 'tok' });
  const notifier = new FakeNotifier();
  notifier.showing = showing;
  const visibility = new FakeVisibility();
  const m = createNotifications({ bus: ctx.bus, api: ctx.api, notifier, transport: ctx.transport, visibility });
  return { ctx, notifier, visibility, m };
}

const app = { origin: 'app' as const };

describe('preview', () => {
  it('makes one plain line and clips it', () => {
    expect(preview('# Done\n\nRan **all** the `tests`:\n```\nok 42\n```\nSee [the log](http://x).')).toBe('Done Ran all the tests: [code] See the log.');
    expect(preview('a'.repeat(300))).toHaveLength(180);
  });
});

describe('notifications', () => {
  it('notifies a reply to an app message once, with a preview that opens the chat', () => {
    const { ctx, notifier } = setup();
    ctx.bus.publish(ev('turn.done', { ref: 'r1', text: 'raw\nREACT: 👍', display_text: 'All **42** tests pass.' } as never, app));
    ctx.bus.publish(ev('turn.done', { ref: 'r1', text: 'again' }, app)); // same ref: deduped
    expect(notifier.posted).toEqual([{ channel: 'replies', tag: 'turn:r1', title: 'EDITH replied', text: 'All 42 tests pass.', link: 'edith://live' }]);
  });

  it('notifies a side-lane reply once, whichever of message.assistant and turn.done comes first', () => {
    const { ctx, notifier } = setup();
    ctx.bus.publish(ev('message.assistant', { text: 'Disk is 40% full.', lane: 'side', ref: 's1' } as never, app));
    ctx.bus.publish(ev('turn.done', { ref: 's1', lane: 'side', text: 'Disk is 40% full.' }, app));
    ctx.bus.publish(ev('message.assistant', { text: 'main lane text, no ref' }, app));
    expect(notifier.posted.map((n) => [n.tag, n.title, n.text])).toEqual([['turn:s1', 'EDITH · parallel task done', 'Disk is 40% full.']]);
  });

  it('leaves replies to Telegram and the terminal alone', () => {
    const { ctx, notifier } = setup();
    ctx.bus.publish(ev('turn.done', { ref: 'tg:1:2', text: 'hi' }, { origin: 'telegram' }));
    ctx.bus.publish(ev('turn.failed', { ref: 'tg:1:3', reason: 'crashed' }, { origin: 'telegram' }));
    expect(notifier.posted).toEqual([]);
  });

  it('sends errors to the errors channel', () => {
    const { ctx, notifier } = setup();
    ctx.bus.publish(ev('turn.failed', { ref: 'r1', reason: 'not_ready' }, app));
    ctx.bus.publish(ev('turn.failed', { ref: 'r2', reason: 'error', detail: '', stderr: 'boom' }, app));
    ctx.bus.publish(ev('turn.done', { ref: 'r3', text: 'API error', is_error: true }, app));
    expect(notifier.posted.map((n) => [n.channel, n.text])).toEqual([
      ['errors', "Claude isn't ready yet. Try again in a moment."],
      ['errors', 'boom'],
      ['errors', 'API error'],
    ]);
  });

  it('notifies a reminder once per due time', () => {
    const { ctx, notifier } = setup();
    const due = ev('reminder.due', { id: 'ab', text: 'Renew the domain', every: 'yearly', due: 100, late: false }, { origin: 'system' });
    ctx.bus.publish(due);
    ctx.bus.publish(due);
    ctx.bus.publish(ev('reminder.due', { id: 'ab', text: 'Renew the domain', due: 200, late: true }, { origin: 'system' }));
    expect(notifier.posted.map((n) => [n.channel, n.tag, n.title])).toEqual([
      ['reminders', 'rem:ab:100', 'Reminder'],
      ['reminders', 'rem:ab:200', 'Reminder (late)'],
    ]);
  });

  it('asks for approval with Allow and Deny that call the App API, and clears it once resolved', () => {
    const { ctx, notifier } = setup();
    ctx.bus.publish(ev('permission.request', { id: 'p 1', tool: 'Bash', detail: 'rm -rf build', lane: 'side' }, { origin: 'telegram' }));
    ctx.bus.publish(ev('permission.request', { id: 'p 1', tool: 'Bash', detail: 'rm -rf build' }));
    expect(notifier.posted).toEqual([
      {
        channel: 'approvals',
        tag: 'perm:p 1',
        title: 'Approve Bash? (parallel task)',
        text: 'rm -rf build',
        link: 'edith://approvals',
        actions: [
          { label: 'Deny', request: { method: 'POST', url: 'http://edith:8787/v1/permissions/p%201', headers: { Authorization: 'Bearer tok' }, body: { allow: false } }, done: 'Denied' },
          { label: 'Allow', request: { method: 'POST', url: 'http://edith:8787/v1/permissions/p%201', headers: { Authorization: 'Bearer tok' }, body: { allow: true } }, done: 'Allowed' },
        ],
      },
    ]);
    ctx.bus.publish(ev('permission.resolved', { id: 'p 1', decision: 'allow' }));
    ctx.bus.publish(ev('permission.resolved', { id: 'p 1', decision: 'allow' }));
    expect(notifier.cancelled).toEqual(['perm:p 1']);
  });

  it('does not notify what is on screen, and clears what comes on screen', () => {
    const { ctx, notifier, visibility } = setup();
    visibility.set(true);
    ctx.bus.publish(localEvent('app.screen', { name: 'sessions' }));
    ctx.bus.publish(ev('permission.request', { id: 'a', tool: 'Bash' })); // the banner shows it on every screen
    ctx.bus.publish(ev('turn.done', { ref: 'r1', text: 'not in view' }, app));
    expect(notifier.posted.map((n) => n.tag)).toEqual(['turn:r1']);

    ctx.bus.publish(localEvent('app.screen', { name: 'live' })); // now it is
    expect(notifier.cancelled).toEqual(['turn:r1']);
    ctx.bus.publish(ev('turn.done', { ref: 'r2', text: 'in view' }, app));
    expect(notifier.posted).toHaveLength(1);

    visibility.set(false); // in the background: notify, and a seen ref never pops up later
    ctx.bus.publish(ev('turn.done', { ref: 'r2', text: 'in view' }, app));
    ctx.bus.publish(ev('turn.done', { ref: 'r3', text: 'away' }, app));
    ctx.bus.publish(ev('permission.request', { id: 'b', tool: 'Write' }));
    expect(notifier.posted.map((n) => n.tag)).toEqual(['turn:r1', 'turn:r3', 'perm:b']);
    visibility.set(true); // back on the chat
    expect(notifier.cancelled).toEqual(['turn:r1', 'turn:r3', 'perm:b']);
  });

  it('on connect: asks for permission once, posts approvals missed, and drops the ones answered meanwhile', async () => {
    const { ctx, notifier } = setup();
    ctx.bus.publish(ev('permission.request', { id: 'old', tool: 'Bash' }));
    ctx.transport.on('GET /v1/permissions', { pending: [{ id: 'new', tool: 'Write', detail: 'a.ts', ref: null, lane: null }] });
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(notifier.asked).toBe(1);
    expect(notifier.posted.map((n) => n.tag)).toEqual(['perm:old', 'perm:new']);
    expect(notifier.cancelled).toEqual(['perm:old']);
  });

  it('remembers a bounded number of refs', () => {
    const { ctx, notifier } = setup();
    for (let i = 0; i <= SEEN_MAX; i++) ctx.bus.publish(ev('turn.done', { ref: `r${i}`, text: 'x' }, app));
    ctx.bus.publish(ev('turn.done', { ref: 'r0', text: 'x' }, app)); // forgotten: the oldest
    ctx.bus.publish(ev('turn.done', { ref: `r${SEEN_MAX}`, text: 'x' }, app)); // still remembered
    expect(notifier.posted).toHaveLength(SEEN_MAX + 2);
  });

  it('stops listening on dispose', () => {
    const { ctx, notifier, m } = setup();
    m.dispose();
    ctx.bus.publish(ev('turn.done', { ref: 'r1', text: 'x' }, app));
    expect(notifier.posted).toEqual([]);
  });

  it('a resync never brings back an approval answered while it was in flight, nor drops one asked meanwhile', async () => {
    const { ctx, notifier } = setup();
    let answer!: (v: unknown) => void;
    ctx.transport.on('GET /v1/permissions', () => new Promise((r) => (answer = r)));
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    ctx.bus.publish(ev('permission.request', { id: 'a', tool: 'Bash' }));
    ctx.bus.publish(ev('permission.resolved', { id: 'a', decision: 'allow' }));
    ctx.bus.publish(ev('permission.request', { id: 'b', tool: 'Write' }));
    answer({ pending: [{ id: 'a', tool: 'Bash', detail: '', ref: null, lane: null }] }); // taken before both
    await flush();
    expect(notifier.posted.map((n) => n.tag)).toEqual(['perm:a', 'perm:b']);
    expect(notifier.cancelled).toEqual(['perm:a']); // by its permission.resolved; b stays
  });

  it('after a restart, takes over the approvals Android still shows and cancels the answered ones', async () => {
    const { ctx, notifier } = setup(['perm:old', 'perm:live', 'turn:r1']);
    ctx.transport.on('GET /v1/permissions', { pending: [{ id: 'live', tool: 'Bash', detail: 'ls', ref: null, lane: null }] });
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    expect(notifier.cancelled).toEqual(['perm:old']);
    expect(notifier.posted).toEqual([]); // perm:live is already showing: not posted twice
    ctx.bus.publish(ev('turn.done', { ref: 'r1', text: 'x' }, app));
    expect(notifier.posted).toEqual([]);
  });
});
