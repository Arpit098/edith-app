// Settings → Widgets: the privacy switch for the home-screen widgets, and how to add them.

import { useStore } from '../../core/store';
import { Section, SettingsPageBody, SummaryCard, SwitchRow } from '../../ui/SettingsRows';
import type { WidgetsModel, WidgetsState } from './model';
import { widgetsSummary } from './summary';

const selectShowText = (s: WidgetsState) => s.showText;

export function WidgetSettings({ model }: { model: WidgetsModel | null }) {
  if (!model) {
    return (
      <SettingsPageBody>
        <SummaryCard icon="widgets-outline" title="Widgets" subtitle="Not available on this phone" />
      </SettingsPageBody>
    );
  }
  return <Available model={model} />;
}

function Available({ model }: { model: WidgetsModel }) {
  const showText = useStore(model.store, selectShowText);
  return (
    <SettingsPageBody>
      <SummaryCard icon="widgets-outline" title="Widgets" subtitle={widgetsSummary(showText)} />
      <Section
        title="Privacy"
        footer="Off: the last-message widget says only “New message from EDITH”, and the text isn’t kept for it. On a lock screen it never shows the text."
      >
        <SwitchRow label="Show message text in widgets" icon="eye-outline" value={showText} onChange={model.setShowText} />
      </Section>
      <Section
        title="Adding them"
        footer="Long-press an empty spot on the home screen, tap Widgets and find EDITH. The EDITH bar opens the chat to type, already listening, or to send a photo. The last-message widget shows her latest reply or alert and whether she’s working; make it taller for the last three."
      />
    </SettingsPageBody>
  );
}
