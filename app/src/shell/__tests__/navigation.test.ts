import { back, current, navigate, type NavState } from '../navigation';

const TABS = new Set(['live', 'sessions', 'tools', 'settings']);
const HOME: NavState = { tab: 'live', stack: [] };

describe('navigation', () => {
  it('switches tabs and stacks tool screens over the current tab', () => {
    let s = navigate(HOME, 'tools', TABS);
    expect(s).toEqual({ tab: 'tools', stack: [] });
    s = navigate(s, 'commands', TABS);
    s = navigate(s, 'reminders', TABS);
    s = navigate(s, 'commands', TABS); // already open: moves to the top, not twice
    expect(s).toEqual({ tab: 'tools', stack: ['reminders', 'commands'] });
    expect(current(s)).toBe('commands');
    expect(navigate(s, 'commands', TABS)).toBe(s);
    expect(navigate(s, 'sessions', TABS)).toEqual({ tab: 'sessions', stack: [] });
    expect(navigate(HOME, 'live', TABS)).toBe(HOME);
  });

  it('goes back through the stack, then home, then lets Android exit', () => {
    let s: NavState | null = { tab: 'tools', stack: ['commands'] };
    s = back(s, 'live');
    expect(s).toEqual({ tab: 'tools', stack: [] });
    s = back(s!, 'live');
    expect(s).toEqual(HOME);
    expect(back(s!, 'live')).toBeNull();
  });
});
