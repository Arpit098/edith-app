import { linkScreen, linkTarget } from '../links';

describe('linkScreen', () => {
  const has = (s: string) => s === 'live' || s === 'approvals';

  it('opens the screen a link names, or the home tab for an unknown one', () => {
    expect(linkScreen('edith://approvals', has, 'live')).toBe('approvals');
    expect(linkScreen('edith://live?from=notification', has, 'live')).toBe('live');
    expect(linkScreen('EDITH://Approvals', has, 'live')).toBe('approvals');
    expect(linkScreen('edith://gone', has, 'live')).toBe('live');
  });

  it('ignores links that are not EDITH', () => {
    expect(linkScreen(null, has, 'live')).toBeNull();
    expect(linkScreen('https://example.com/approvals', has, 'live')).toBeNull();
    expect(linkScreen('exp+edith://expo-development-client', has, 'live')).toBeNull();
  });
});

describe('linkTarget', () => {
  const has = (s: string) => s === 'live' || s === 'settings';

  it('opens a Settings page from the link (the update notification)', () => {
    expect(linkTarget('edith://settings/updates', has, 'live')).toEqual({ screen: 'settings', page: 'updates' });
    expect(linkTarget('edith://Settings/Updates?from=push', has, 'live')).toEqual({ screen: 'settings', page: 'updates' });
    expect(linkTarget('edith://settings', has, 'live')).toEqual({ screen: 'settings', page: null });
    expect(linkTarget('edith://gone/updates', has, 'live')).toEqual({ screen: 'live', page: null });
    expect(linkTarget('https://x/settings/updates', has, 'live')).toBeNull();
  });
});
