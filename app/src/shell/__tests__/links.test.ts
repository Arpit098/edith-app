import { linkScreen } from '../links';

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
