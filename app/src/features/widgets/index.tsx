// Home-screen widgets (contracts/widgets.md): the EDITH bar (Type, Mic, Attach: edith://live/…
// links the live session carries out) and EDITH's last message with a status dot. This feature
// keeps the last-message widget's snapshot current while the app is connected, and holds the
// "Show message text in widgets" setting. Needs ports.widgets (absent in tests and on web).

import { useMemo } from 'react';

import type { FeatureModule, SettingsToggle } from '../../core/feature';
import { useStoreOr } from '../../core/store';
import { createWidgetsModel, type WidgetsModel, type WidgetsState } from './model';
import { widgetsSummary } from './summary';
import { WidgetSettings } from './WidgetSettings';

let model: WidgetsModel | null = null;

const selectShowText = (s: WidgetsState) => s.showText;

function Settings() {
  return <WidgetSettings model={model} />;
}

function useSummary() {
  const showText = useStoreOr(model?.store, selectShowText, null);
  return showText === null ? 'Not available on this phone' : widgetsSummary(showText);
}

function useToggle(): SettingsToggle | null {
  const showText = useStoreOr(model?.store, selectShowText, null);
  const m = model;
  // The same object while the switch's state is the same (the row and its switch are memoised).
  return useMemo(() => (m && showText !== null ? { on: showText, set: m.setShowText, detail: 'Message text' } : null), [m, showText]);
}

const widgets: FeatureModule = {
  id: 'widgets',
  settings: [{ title: 'Widgets', component: Settings, group: 'app', icon: 'widgets-outline', order: 30, summary: useSummary, toggle: useToggle }],
  setup: ({ bus, api, ports }) => {
    if (!ports.widgets) return;
    const m = createWidgetsModel({ bus, api, widgets: ports.widgets });
    model = m;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default widgets;
