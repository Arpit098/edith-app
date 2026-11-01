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
    // git: any case, PR on its own
    ['Bash', '$ Commit the fix', 'git'],
    ['Bash', '$ Rebase onto main', 'git'],
    ['Bash', '$ Open a PR for the work card', 'git'],
    ['Bash', '$ Prepare the price list', 'search'],
    // looking around comes before tests, unless it runs them
    ['Bash', '$ Find the failing tests', 'search'],
    ['Bash', '$ List test files', 'search'],
    ['Bash', '$ ls app/src/__tests__ | grep test', 'search'],
    ['Bash', '$ Show the jest config', 'search'],
    ['Bash', '$ Run the tests and show the output', 'test'],
    ['Bash', '$ npm test -- -t find', 'test'],
    ['Bash', '$ pytest -k list', 'test'],
    ['Bash', '$ make test | grep FAIL', 'test'],
    // deploy, narrowed
    ['Bash', '$ Show the release notes', 'search'],
    ['Bash', '$ Deploy the bridge', 'deploy'],
    ['Bash', '$ Restart the bridge', 'deploy'],
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
