import { ApiError } from '../api';
import { Connection, normalizeBaseUrl } from '../connection';
import { EventBus, type EdithEvent } from '../events';
import { ev, FakeTransport, MemoryStorage } from '../../testing/fakes';

const TOKEN = 'x'.repeat(40);
const STATUS = { main: 'idle', queued: 0, runs: [], tmux: 'running', conversation: true, session: null };

function setup() {
  const transport = new FakeTransport();
  const storage = new MemoryStorage();
  const bus = new EventBus();
  const seen: EdithEvent[] = [];
  bus.subscribe('*', (e) => seen.push(e));
  return { transport, storage, bus, seen, conn: new Connection(transport, storage, bus) };
}

describe('normalizeBaseUrl', () => {
  it.each([
    ['edith', 'http://edith:8787'],
    [' 100.64.1.2:9000/ ', 'http://100.64.1.2:9000'],
    ['HTTPS://Edith.Tail1234.ts.net', 'https://edith.tail1234.ts.net:8787'],
    ['http://[fd7a:115c::1]:8787', 'http://[fd7a:115c::1]:8787'],
  ])('%s -> %s', (input, out) => expect(normalizeBaseUrl(input)).toBe(out));

  it.each(['', 'ftp://edith', 'edith:99999', 'edith/v1', 'a b'])('rejects %p', (input) => {
    expect(() => normalizeBaseUrl(input)).toThrow();
  });
});

describe('Connection', () => {
  it('starts unconfigured with nothing saved', async () => {
    const { conn, transport } = setup();
    await conn.load();
    expect(conn.store.get().link).toBe('unconfigured');
    expect(transport.streaming).toBe(0);
  });

  it('verifies, saves and streams on connect', async () => {
    const { conn, transport, storage, seen } = setup();
    transport.on('GET /v1/status', STATUS);
    await conn.connect('edith', ` ${TOKEN} `);
    expect(transport.config).toEqual({ baseUrl: 'http://edith:8787', token: TOKEN });
    expect(storage.data.get('edith.token')).toBe(TOKEN);
    expect(conn.store.get().link).toBe('connecting');
    expect(transport.streaming).toBe(1);

    transport.status({ state: 'open' });
    expect(conn.store.get().link).toBe('open');
    transport.emit(ev('turn.started', { ref: 'r' }));
    transport.status({ state: 'closed', retryInMs: 2000, error: 'network' });
    expect(conn.store.get()).toMatchObject({ link: 'offline', retryInMs: 2000 });
    transport.status({ state: 'open' });
    expect(seen.map((e) => [e.type, (e.data as { first?: boolean }).first])).toEqual([
      ['app.connected', true],
      ['turn.started', undefined],
      ['app.connected', false],
    ]);
  });

  it('reports a rejected token and saves nothing', async () => {
    const { conn, transport, storage } = setup();
    transport.on('GET /v1/status', () => {
      throw new ApiError(401, 'unauthorized');
    });
    await expect(conn.connect('edith', TOKEN)).rejects.toThrow('rejected this token');
    expect(storage.data.size).toBe(0);
    expect(transport.config).toBeNull();
    expect(transport.streaming).toBe(0);
  });

  it('explains an unreachable server', async () => {
    const { conn, transport } = setup();
    transport.on('GET /v1/status', () => {
      throw new ApiError(0, 'timed out');
    });
    await expect(conn.connect('100.64.0.9', TOKEN)).rejects.toThrow("Can't reach http://100.64.0.9:8787. Is Tailscale on?");
  });

  it('restores the saved server, and forget() drops only the token', async () => {
    const { conn, transport, storage } = setup();
    storage.data.set('edith.baseUrl', 'http://edith:8787');
    storage.data.set('edith.token', TOKEN);
    await conn.load();
    expect(transport.streaming).toBe(1);
    transport.status({ state: 'closed', retryInMs: null, error: 'unauthorized' });
    expect(conn.store.get().link).toBe('unauthorized');

    await conn.forget();
    expect(transport.streaming).toBe(0);
    expect(transport.config).toBeNull();
    expect(storage.data.has('edith.token')).toBe(false);
    expect(conn.store.get()).toMatchObject({ link: 'unconfigured', baseUrl: 'http://edith:8787' });
  });

  it('retry() asks the transport to reconnect', () => {
    const { conn, transport } = setup();
    conn.retry();
    expect(transport.reconnects).toBe(1);
  });
});
