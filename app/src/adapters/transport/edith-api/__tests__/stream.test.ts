import type { EdithEvent } from '../../../../core/events';
import type { StreamStatus } from '../../../../core/ports';
import { EventStream, parseFrame, streamUrl, type AppStateLike, type WebSocketLike } from '../stream';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data?: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // server side
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(obj: unknown) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  drop(reason = '', code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

class FakeAppState implements AppStateLike {
  currentState = 'active';
  private listener: ((s: string) => void) | null = null;
  addEventListener(_type: 'change', listener: (s: string) => void) {
    this.listener = listener;
    return { remove: () => (this.listener = null) };
  }
  set(s: string) {
    this.currentState = s;
    this.listener?.(s);
  }
  get listening() {
    return this.listener !== null;
  }
}

const SERVER = { baseUrl: 'http://100.64.0.1:8787', token: 'secret' };

function setup() {
  const sockets: FakeSocket[] = [];
  const appState = new FakeAppState();
  const stream = new EventStream({
    connect: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    appState,
    heartbeatMs: 25_000,
    connectTimeoutMs: 10_000,
    backgroundGraceMs: 60_000,
    backoff: { baseMs: 1000, maxMs: 30_000 },
    random: () => 1,
  });
  const events: EdithEvent[] = [];
  const statuses: StreamStatus[] = [];
  const last = () => sockets[sockets.length - 1]!;
  const advance = (ms: number) => jest.advanceTimersByTime(ms); // modern fake timers move Date.now too
  return { stream, sockets, appState, events, statuses, last, advance, listen: () => stream.listen({ onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) }) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('parseFrame', () => {
  it('reads events and rejects junk', () => {
    expect(parseFrame('{"type":"turn.done","ts":5,"session_id":"s","origin":"app","data":{"ref":"r"}}')).toEqual({
      type: 'turn.done',
      ts: 5,
      session_id: 's',
      origin: 'app',
      data: { ref: 'r' },
    });
    expect(parseFrame('{"type":"x","origin":"evil","data":[1]}')).toMatchObject({ origin: 'system', data: {}, session_id: null });
    expect(parseFrame('{"type":"pong"}')).toBe('pong');
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('{"data":{}}')).toBeNull();
    expect(parseFrame(new ArrayBuffer(2))).toBeNull();
  });

  it('builds the ws url', () => {
    expect(streamUrl('http://edith:8787')).toBe('ws://edith:8787/v1/stream?client=app');
    expect(streamUrl('https://edith:8787')).toBe('wss://edith:8787/v1/stream?client=app');
  });
});

describe('EventStream', () => {
  it('opens one socket with the token only when configured and listened to', () => {
    const t = setup();
    t.listen();
    expect(t.sockets).toHaveLength(0);
    t.stream.configure(SERVER);
    t.stream.listen({ onEvent: () => {} }); // a second listener shares the socket
    expect(t.sockets).toHaveLength(1);
    expect(t.last().url).toBe('ws://100.64.0.1:8787/v1/stream?client=app');
    expect(t.last().headers).toEqual({ Authorization: 'Bearer secret' });
    t.last().accept();
    t.last().message({ type: 'turn.started', ts: 1, origin: 'app', data: { ref: 'r' } });
    t.last().message('garbage');
    expect(t.events.map((e) => e.type)).toEqual(['turn.started']);
    expect(t.statuses.map((s) => s.state)).toEqual(['idle', 'connecting', 'open']);
  });

  it('reconnects with growing backoff, and resets it once open', () => {
    const t = setup();
    t.stream.configure(SERVER);
    t.listen();
    t.last().drop('Connection refused');
    expect(t.statuses.at(-1)).toEqual({ state: 'closed', retryInMs: 1000, error: 'Connection refused' });
    t.advance(999);
    expect(t.sockets).toHaveLength(1);
    t.advance(1);
    expect(t.sockets).toHaveLength(2);
    t.last().drop('Connection refused');
    expect(t.statuses.at(-1)?.retryInMs).toBe(2000);
    t.advance(2000);
    t.last().accept();
    t.last().drop('Software caused connection abort');
    expect(t.statuses.at(-1)?.retryInMs).toBe(1000);
  });

  it('gives up on a rejected token until asked again', () => {
    const t = setup();
    t.stream.configure(SERVER);
    t.listen();
    t.last().drop("Expected HTTP 101 response but was '401 Unauthorized'");
    expect(t.statuses.at(-1)).toEqual({ state: 'closed', retryInMs: null, error: 'unauthorized' });
    t.advance(120_000);
    expect(t.sockets).toHaveLength(1);
    t.stream.reconnect();
    expect(t.sockets).toHaveLength(2);
  });

  it('times out a connect that never opens', () => {
    const t = setup();
    t.stream.configure(SERVER);
    t.listen();
    t.advance(10_000);
    expect(t.sockets[0]!.closed).toBe(true);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'closed', error: 'timed out' });
  });

  it('pings every heartbeat, and drops a silent link once the server answers pongs', () => {
    const t = setup();
    t.stream.configure(SERVER);
    t.listen();
    t.last().accept();
    t.advance(25_000);
    expect(t.last().sent).toEqual(['{"type":"ping"}']);
    t.advance(100_000); // no pong support seen yet: silence is normal (an idle server)
    expect(t.sockets).toHaveLength(1);
    t.last().message({ type: 'pong' });
    t.advance(75_000); // > 2.5 heartbeats without anything inbound
    expect(t.sockets[0]!.closed).toBe(true);
    expect(t.statuses.at(-1)).toMatchObject({ state: 'closed', error: 'no heartbeat' });
  });

  it('closes after the background grace period and reconnects in the foreground', () => {
    const t = setup();
    t.stream.configure(SERVER);
    t.listen();
    t.last().accept();
    t.appState.set('background');
    t.advance(30_000);
    t.appState.set('active'); // quick app switch: keeps the socket
    t.appState.set('background');
    t.advance(59_000);
    expect(t.sockets[0]!.closed).toBe(false);
    t.advance(1_000);
    expect(t.sockets[0]!.closed).toBe(true);
    expect(t.statuses.at(-1)?.state).toBe('idle');
    t.advance(600_000);
    expect(t.sockets).toHaveLength(1); // nothing while paused
    t.appState.set('active');
    expect(t.sockets).toHaveLength(2);
  });

  it('stays connected in the background while held, and pauses after the grace once released', () => {
    const t = setup();
    t.stream.configure(SERVER);
    t.listen();
    t.last().accept();
    const release = t.stream.holdOpen();
    t.appState.set('background');
    t.advance(600_000);
    expect(t.sockets[0]!.closed).toBe(false);
    release();
    release(); // twice is harmless
    t.advance(59_000);
    expect(t.sockets[0]!.closed).toBe(false);
    t.advance(1_000);
    expect(t.sockets[0]!.closed).toBe(true);

    // a hold taken while paused reconnects at once
    const again = t.stream.holdOpen();
    expect(t.sockets).toHaveLength(2);
    again();
  });

  it('closes and stops listening to AppState when the last listener leaves; configure(null) stops', () => {
    const t = setup();
    t.stream.configure(SERVER);
    const off = t.listen();
    t.last().accept();
    off();
    expect(t.sockets[0]!.closed).toBe(true);
    expect(t.appState.listening).toBe(false);

    t.listen();
    expect(t.sockets).toHaveLength(2);
    const second = t.last();
    t.stream.configure(null);
    expect(second.closed).toBe(true);
    second.drop('late'); // callbacks of a dropped socket are ignored
    t.advance(60_000);
    expect(t.sockets).toHaveLength(2);
  });
});
