// The Settings list's layout: groups in a fixed order, sections sorted inside each, old-style
// sections (title and component only) still shown, and the real features where Arpit asked for them.

import type { SettingsSection } from '../../core/feature';
import { loadFeatures } from '../../core/feature';
import { features } from '../../features';
import { fakeContext } from '../../testing/fakes';
import { isIcon } from '../../ui/Icon';
import { shellSections } from '../SettingsScreen';
import { DEFAULT_ICON, GROUPS, groupSections } from '../settingsGroups';

jest.mock('../../ui/toast', () => ({ toast: jest.fn() }));

const Nothing = () => null;
const section = (title: string, extra: Partial<SettingsSection> = {}): SettingsSection => ({ title, component: Nothing, ...extra });
const layout = (sections: SettingsSection[]) => groupSections(sections).map((g) => [g.title, g.sections.map((s) => s.title)]);

describe('groupSections', () => {
  it('keeps the group order whatever order the sections come in, and drops empty groups', () => {
    expect(
      layout([section('Updates', { group: 'app' }), section('Push', { group: 'notifications' }), section('Server', { group: 'connection' })]),
    ).toEqual([
      ['Connection & account', ['Server']],
      ['Notifications', ['Push']],
      ['App', ['Updates']],
    ]);
  });

  it('sorts by order inside a group, then by title; no order counts as 100', () => {
    expect(
      layout([
        section('Zeta', { group: 'voice' }),
        section('Late', { group: 'voice', order: 200 }),
        section('Alpha', { group: 'voice' }),
        section('First', { group: 'voice', order: 1 }),
      ]),
    ).toEqual([['Voice', ['First', 'Alpha', 'Zeta', 'Late']]]);
  });

  it('puts an old-style section (title and component only) or an unknown group under More, last', () => {
    const old = section('Legacy');
    const future = section('Future', { group: 'labs' as SettingsSection['group'] });
    expect(layout([old, section('Updates', { group: 'app' }), future])).toEqual([
      ['App', ['Updates']],
      ['More', ['Future', 'Legacy']],
    ]);
    expect(GROUPS.at(-1)!.id).toBe('more');
  });

  it('does not change the list it was given', () => {
    const list = [section('B', { group: 'app' }), section('A', { group: 'app' })];
    groupSections(list);
    expect(list.map((s) => s.title)).toEqual(['B', 'A']);
  });
});

describe('the real Settings', () => {
  it('groups the features and the shell’s own sections as asked, each with a real outline icon', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = fakeContext();
    const loaded = loadFeatures(features, ctx);
    expect(loaded.failed).toEqual({});
    const meter = { start: () => {}, stop: async () => ({}) } as unknown as Parameters<typeof shellSections>[1];
    const all = [...shellSections(ctx.connection, meter), ...loaded.settings];
    expect(layout(all)).toEqual([
      ['Connection & account', ['Server connection', 'Claude accounts']],
      ['Notifications', ['Push', 'Live Alerts']],
      ['Voice', ['Voice input', 'Wake word']],
      ['App', ['Appearance', 'Chat', 'Updates', 'Developer']],
    ]);
    for (const s of all) {
      expect(isIcon(s.icon ?? DEFAULT_ICON)).toBe(true);
      expect(typeof s.summary).toBe('function');
    }
    expect(layout(shellSections(ctx.connection, null))).toEqual([['Connection & account', ['Server connection']]]); // no meter: no Developer page
    loaded.cleanup();
  });
});
