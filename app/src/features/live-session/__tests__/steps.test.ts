// Work card steps: a kind (and icon) from the tool and its summary; labels without the "$" prefix.

import { STEP_ICON, stepKind, stepLabel } from '../steps';

describe('step kinds', () => {
  it.each([
    ['Read', '/x/a.ts', 'search'],
    ['Grep', 'busy', 'search'],
    ['Edit', 'Edit: /x/a.ts', 'edit'],
    ['Write', '/x/b.ts', 'edit'],
    ['WebFetch', 'https://example.com', 'web'],
    ['Task', 'Explore the repo', 'agent'],
    ['Bash', '$ Run the app tests', 'test'],
    ['Bash', '$ npm run check', 'test'],
    ['Bash', '$ Commit and push the branch', 'git'],
    ['Bash', '$ gh pr create', 'git'],
    ['Bash', '$ systemctl --user restart edith-bridge', 'deploy'],
    ['Bash', '$ Find placeholder text in the composer', 'search'],
    ['Bash', '$ Create worktree and view the placeholder', 'git'],
    ['Bash', '$ sleep 1', 'other'],
  ])('%s %s → %s', (tool, summary, kind) => {
    expect(stepKind(tool, summary)).toBe(kind);
  });

  it('has an icon for every kind', () => {
    expect(Object.values(STEP_ICON).every((i) => i.length > 0)).toBe(true);
  });

  it('labels drop the "$" and "Tool:" prefixes and keep one line', () => {
    expect(stepLabel('Bash', '$ Check busy usage\nmore')).toBe('Check busy usage');
    expect(stepLabel('Edit', 'Edit: /x/a.ts')).toBe('/x/a.ts');
    expect(stepLabel('Bash', '')).toBe('Bash');
  });
});
