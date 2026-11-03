import { createAndroidWidgets, parseSnapshot } from '..';

describe('parseSnapshot', () => {
  it('reads what the native side saved (WidgetSnapshot.toJson)', () => {
    const raw = JSON.stringify({
      v: 1,
      at: 1_800_000_000,
      state: 'waiting',
      messages: [{ text: '🔐 Approve Bash? ls', ts: 1_799_999_990, alert: true }],
      permission: { id: 'p1', text: '🔐 Approve Bash? ls' },
      hidden: false,
    });
    expect(parseSnapshot(raw)).toEqual({
      v: 1,
      at: 1_800_000_000,
      state: 'waiting',
      messages: [{ text: '🔐 Approve Bash? ls', ts: 1_799_999_990, alert: true }],
      permission: { id: 'p1', text: '🔐 Approve Bash? ls' },
      hidden: false,
    });
  });

  it('treats never written, malformed or newer snapshots as nothing saved', () => {
    expect(parseSnapshot('')).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('{nope')).toBeNull();
    expect(parseSnapshot('[1]')).toBeNull();
    expect(parseSnapshot(JSON.stringify({ v: 1, at: 0, state: 'idle', messages: [], permission: null, hidden: false }))).toBeNull(); // the native EMPTY
    expect(parseSnapshot(JSON.stringify({ v: 2, at: 5, state: 'idle', messages: [] }))).toBeNull();
  });

  it('repairs what it can: unknown state, bad lines, too many lines, an empty permission', () => {
    const s = parseSnapshot(
      JSON.stringify({ v: 1, at: 5, state: 'dancing', messages: [{ text: 'a', ts: 4 }, 'junk', { text: 7 }, { text: 'c', ts: 1 }, { text: 'd', ts: 0 }], permission: { id: '' } }),
    );
    expect(s).toEqual({ v: 1, at: 5, state: 'idle', messages: [{ text: 'a', ts: 4, alert: false }, { text: '', ts: 0, alert: false }], permission: null, hidden: false });
  });
});

describe('createAndroidWidgets', () => {
  it('is absent without the native module (jest, web)', () => {
    expect(createAndroidWidgets()).toBeNull();
  });
});
