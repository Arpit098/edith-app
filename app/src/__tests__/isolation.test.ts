// Import rules from docs/ARCHITECTURE.md, enforced like server/tests/test_isolation.py:
//   core     -> core (+ react)          common -> core, common
//   ui       -> core, common, ui        adapters -> core, common, own adapter (+ libraries)
//   features -> core, common, ui, own folder (never another feature or an adapter)
// shell/, App.tsx and the registry features/index.ts are the composition root and may import anything.

import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' ? [] : files(p);
    return /\.tsx?$/.test(d.name) ? [p] : [];
  });
}

/** [layer, sub-folder] of a path under src/, e.g. ["features", "sessions"]. */
function where(file: string): [string, string] {
  const [layer = '', a = '', b = ''] = path.relative(SRC, file).split(path.sep);
  return [layer, layer === 'adapters' ? `${a}/${b}` : a];
}

const ROOT = new Set(['App.tsx', path.join('features', 'index.ts')]);

function violations(extra: { file: string; text: string }[] = []): string[] {
  const out: string[] = [];
  const sources = [...files(SRC).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })), ...extra];
  for (const { file, text } of sources) {
    const [layer, own] = where(file);
    if (layer === 'shell' || layer === 'testing' || ROOT.has(path.relative(SRC, file))) continue;
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!;
      const rel = path.relative(SRC, file);
      if (!spec.startsWith('.')) {
        // Libraries: features, core, common and ui reach the device only through ports and ui.
        // ui/ may also use view-only drawing libraries (no device access).
        const allowed =
          layer === 'adapters' ||
          ['react', 'react-native', '@expo/vector-icons/MaterialCommunityIcons', 'react-native-safe-area-context'].includes(spec) ||
          (layer === 'ui' && ['react-native-svg'].includes(spec));
        const coreOk = layer === 'core' || layer === 'common' ? spec === 'react' : true;
        if (!allowed || !coreOk) out.push(`${rel}: imports library ${spec}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec);
      const [tLayer, tOwn] = where(target);
      const ok =
        tLayer === 'core' ||
        (tLayer === 'common' && layer !== 'core') ||
        (tLayer === 'ui' && (layer === 'ui' || layer === 'features')) ||
        (tLayer === layer && (tOwn === own || layer === 'core' || layer === 'common' || layer === 'ui' || layer === 'adapters'));
      if (!ok) out.push(`${rel}: imports ${spec} (${tLayer}/${tOwn})`);
    }
  }
  return out;
}

describe('import rules', () => {
  it('features, adapters, common and core stay isolated', () => {
    expect(violations()).toEqual([]);
  });

  it('the checker catches bad imports', () => {
    const at = (p: string) => path.join(SRC, ...p.split('/'));
    expect(
      violations([
        { file: at('features/sessions/probe.ts'), text: "import x from '../live-session/model';" },
        { file: at('features/sessions/probe2.ts'), text: "import { t } from '../../adapters/transport/edith-api';" },
        { file: at('features/sessions/probe3.ts'), text: "import * as S from 'expo-secure-store';" },
        { file: at('core/probe.ts'), text: "import { timeAgo } from '../common/format';" },
        { file: at('common/probe.ts'), text: "import { Button } from '../ui/Button';" },
      ]).map((v) => v.split(':')[0]),
    ).toEqual(['features/sessions/probe.ts', 'features/sessions/probe2.ts', 'features/sessions/probe3.ts', 'core/probe.ts', 'common/probe.ts']);
  });
});
