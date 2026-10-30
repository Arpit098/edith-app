// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseBlock, collect, empty } = require('../release-notes.js');

const block = (lines: string) => `## Summary\nSome text.\n\n## Release notes\n${lines}\n\n## Tests\nNew: not a note`;

describe('parseBlock', () => {
  it('reads New and Fix lines under the heading only', () => {
    expect(parseBlock(block('New: Send photos from the app\nFix: Messages no longer vanish\n- fix: Lists show again'))).toEqual({
      found: true,
      new: ['Send photos from the app'],
      fixes: ['Messages no longer vanish', 'Lists show again'],
    });
  });

  it('drops Internal lines and the template placeholders', () => {
    expect(parseBlock(block('Internal: no user-visible change\nNew: <one plain sentence>'))).toEqual({ found: true, new: [], fixes: [] });
  });

  it('says when there is no block', () => {
    expect(parseBlock('Just a description').found).toBe(false);
    expect(parseBlock(null).found).toBe(false);
  });

  it('cuts very long lines', () => {
    expect(parseBlock(block(`New: ${'x'.repeat(500)}`)).new[0]).toHaveLength(160);
  });
});

describe('collect', () => {
  it('merges the blocks, dedupes, falls back to titles and keeps the subjects as details', () => {
    const prs = [
      { title: 'App attachments', body: block('New: Attach photos and voice notes') },
      { title: 'Message tracking', body: block('Fix: Messages no longer vanish.\nNew: attach photos and voice notes') },
      { title: 'CI cache', body: block('Internal: no user-visible change') },
      { title: 'Brand icon', body: 'No block here' },
    ];
    expect(collect(prs, ['feat: one\nbody', 'fix: two', 'feat: one'])).toEqual({
      new: ['Attach photos and voice notes'],
      fixes: ['Messages no longer vanish.'],
      changes: ['Brand icon'],
      details: ['feat: one', 'fix: two'],
    });
  });

  it('caps every list', () => {
    const prs = Array.from({ length: 40 }, (_, i) => ({ title: `PR ${i}`, body: block(`New: thing ${i}`) }));
    const notes = collect(prs, Array.from({ length: 50 }, (_, i) => `commit ${i}`));
    expect(notes.new).toHaveLength(20);
    expect(notes.details).toHaveLength(30);
  });

  it('has an empty shape for builds without notes', () => {
    expect(empty()).toEqual({ new: [], fixes: [], changes: [], details: [] });
  });
});
