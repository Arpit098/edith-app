import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import type { AppRelease } from '../../../core/api';
import { noteSections } from '../model';
import { ReleaseNotes } from '../ReleaseNotes';

const release = (over: Partial<AppRelease>): AppRelease => ({
  versionName: '0.4.0',
  versionCode: 1050,
  sha: 'abc',
  built_at: 1793600000,
  runtimeVersion: 'rv',
  size: 1000,
  sha256: 'a'.repeat(64),
  cert_sha256: 'X',
  notes: '',
  release_notes: null,
  url: '/v1/app/apk/1050',
  ...over,
});

const notes = { new: ['Attach photos and voice notes'], fixes: ['Messages no longer vanish'], changes: [], details: ['feat: attachments', 'fix: message log'] };

function texts(r: ReactTestRenderer): string[] {
  return r.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
}

describe('noteSections', () => {
  it('lists New and Fixes, leaving out empty lists, with the commit subjects as details', () => {
    expect(noteSections(release({ release_notes: notes }))).toEqual({
      sections: [
        { title: 'New', items: ['Attach photos and voice notes'] },
        { title: 'Fixes', items: ['Messages no longer vanish'] },
      ],
      details: ['feat: attachments', 'fix: message log'],
    });
  });

  it('puts an older build’s plain notes under the details', () => {
    expect(noteSections(release({ notes: 'feat: one\n\nfix: two\n' }))).toEqual({ sections: [], details: ['feat: one', 'fix: two'] });
    expect(noteSections(release({ release_notes: { new: [], fixes: [], changes: [], details: [] }, notes: 'feat: x' })).details).toEqual(['feat: x']);
  });
});

describe('ReleaseNotes', () => {
  it('shows the lists, and the technical details only when opened', () => {
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<ReleaseNotes release={release({ release_notes: notes })} />);
    });
    expect(texts(r)).toEqual(expect.arrayContaining(['New', 'Attach photos and voice notes', 'Fixes', 'Messages no longer vanish', '▸ Technical details']));
    expect(texts(r)).not.toContain('feat: attachments');
    const toggle = r.root.find((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function');
    act(() => toggle.props.onPress());
    expect(texts(r)).toEqual(expect.arrayContaining(['▾ Technical details', 'feat: attachments', 'fix: message log']));
  });

  it('shows nothing without notes', () => {
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<ReleaseNotes release={release({})} />);
    });
    expect(r.toJSON()).toBeNull();
  });
});
