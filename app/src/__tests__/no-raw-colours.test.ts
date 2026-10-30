// Every colour comes from the theme tokens (src/core/theme, PLAN.md §4.11): screens and components
// never write a colour value themselves, so the whole app keeps one look.

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');
const THEME = path.join(SRC, 'core', 'theme');
// Hex colours, rgb()/rgba()/hsl() and CSS named colours other than 'transparent'.
const RAW = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|['"](?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink)['"]/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' || p === THEME ? [] : files(p);
    return /\.tsx?$/.test(d.name) ? [p] : [];
  });
}

function offenders(sources: { file: string; text: string }[]): string[] {
  return sources.flatMap(({ file, text }) =>
    text
      .split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => !line.trim().startsWith('//') && RAW.test(line))
      .map(({ i }) => `${path.relative(SRC, file)}:${i + 1}`),
  );
}

describe('colours', () => {
  it('come only from core/theme', () => {
    expect(offenders(files(SRC).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })))).toEqual([]);
  });

  it('the check catches raw colours', () => {
    const probe = (text: string) => offenders([{ file: path.join(SRC, 'x.tsx'), text }]);
    expect(probe("const s = { color: '#fff' };")).toHaveLength(1);
    expect(probe("backgroundColor: 'rgba(0,0,0,0.5)'")).toHaveLength(1);
    expect(probe("color: 'white'")).toHaveLength(1);
    expect(probe("backgroundColor: 'transparent'")).toHaveLength(0);
    expect(probe('// a comment with #fff')).toHaveLength(0);
  });
});
