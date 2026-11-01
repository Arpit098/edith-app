// Settings → Chat → Work details: how much of EDITH's work (the commands she runs, the files she
// edits) each turn's Work card shows, as a segmented choice with what it means under it.

import { useStore } from '../../core/store';
import { Section, SegmentRow, SettingsPageBody, SummaryCard } from '../../ui/SettingsRows';
import type { WorkDetailSetting } from './chatSettings';
import { WORK_DETAILS, type WorkDetail } from './work';

const OPTIONS = WORK_DETAILS.map((d) => ({ id: d.id, label: d.name }));
const selectDetail = (d: WorkDetail) => d;

export function ChatSettings({ setting }: { setting: WorkDetailSetting }) {
  const chosen = useStore(setting.store, selectDetail);
  const detail = WORK_DETAILS.find((d) => d.id === chosen) ?? WORK_DETAILS[1]!;
  return (
    <SettingsPageBody>
      <SummaryCard icon="message-cog-outline" title="Chat" subtitle={chatSummary(detail.name)} />
      <Section title="Work details" footer={`${detail.hint} A failed step always shows, whatever this is set to.`}>
        <SegmentRow label="Each turn’s Work card shows" icon="format-list-checks" options={OPTIONS} value={chosen} onChange={setting.set} />
      </Section>
    </SettingsPageBody>
  );
}

/** The Settings row's line: "Work details: Steps". */
export function chatSummary(name: string | undefined): string {
  return `Work details: ${name ?? 'Steps'}`;
}
