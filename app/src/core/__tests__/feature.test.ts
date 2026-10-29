import { loadFeatures, type FeatureModule } from '../feature';
import { fakeContext } from '../../testing/fakes';

const Noop = () => null;

describe('loadFeatures', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));

  it('collects screens, tools and panels and isolates failures', () => {
    const cleaned: string[] = [];
    const features: FeatureModule[] = [
      {
        id: 'a',
        screens: [{ name: 'a', title: 'A', component: Noop, tab: true }],
        panels: [{ slot: 'banner', component: Noop }],
        setup: () => () => cleaned.push('a'),
      },
      {
        id: 'broken',
        screens: [{ name: 'b', title: 'B', component: Noop }],
        setup: () => {
          throw new Error('nope');
        },
      },
      { id: 'dup', screens: [{ name: 'a', title: 'A again', component: Noop }] },
      { id: 'badtool', screens: [], tool: { title: 'T', icon: 'x', screen: 'missing' } },
      {
        id: 'c',
        screens: [{ name: 'c', title: 'C', component: Noop }],
        tool: { title: 'C', icon: 'alarm', screen: 'c' },
        setup: () => () => cleaned.push('c'),
      },
      { id: 'c', screens: [] },
    ];
    const loaded = loadFeatures(features, fakeContext());
    expect(loaded.screens.map((s) => s.name)).toEqual(['a', 'c']);
    expect(loaded.tools).toEqual([{ title: 'C', icon: 'alarm', screen: 'c' }]);
    expect(loaded.panels).toHaveLength(1);
    expect(Object.keys(loaded.failed).sort()).toEqual(['badtool', 'broken', 'c', 'dup']);
    loaded.cleanup();
    expect(cleaned).toEqual(['c', 'a']);
  });
});
