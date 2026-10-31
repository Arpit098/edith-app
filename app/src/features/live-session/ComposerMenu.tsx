// The composer's menu (Arpit's reference): a frosted glass panel above the round menu button, with
// rows of an outline icon and a label: Camera, Gallery, Audio file, Record and Commands (a second
// page listing the server's /commands). It grows out of the button on a spring and shrinks back
// into it, closes on a tap outside or Android's back (back on the commands page goes to the first
// page), and is unmounted once closed, so a closed menu costs nothing.

import { memo, useCallback, useEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { AccessibilityInfo, ActivityIndicator, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Command } from '../../core/api';
import { useStore, type Store } from '../../core/store';
import { colors, legibleText, radius, space, type, useTheme } from '../../core/theme';
import { Glass } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { GrowSheet, Squish } from '../../ui/motion';
import type { AttachmentsModel, DraftsState } from './attachments';
import { needsArgs } from './model';
import type { VoiceModel, VoiceState } from './voice';

export const MENU_LABEL = 'Composer menu';
export const CLOSE_LABEL = 'Close the composer menu';

type Page = 'main' | 'commands';

export interface ComposerMenuProps {
  /** Whether it's open (the composer's menu button and this share it). */
  open: Store<boolean>;
  bottom: number; // just above the composer
  backdrop: number | null;
  attach: AttachmentsModel;
  voice: VoiceModel;
  loadCommands: () => Promise<Command[]>;
  onCommand: (command: Command) => void;
}

const selectOpen = (s: boolean) => s;
const selectPicking = (s: DraftsState) => s.picking;
const selectCanTalk = (s: VoiceState) => s.available;
const selectIdle = (s: VoiceState) => s.phase === 'idle';

export function ComposerMenu({ open: openStore, bottom, backdrop, attach, voice, loadCommands, onCommand }: ComposerMenuProps) {
  const open = useStore(openStore, selectOpen);
  const [page, setPage] = useState<Page>('main');
  const close = useCallback(() => openStore.set(false), [openStore]);

  // Each opening starts on the first page (set while rendering, so the old page never shows a frame).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPage('main');
  }

  // Back closes the commands page, then the menu (handlers run newest first: this beats the shell's).
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page === 'commands') setPage('main');
      else close();
      return true;
    });
    return () => sub.remove();
  }, [open, page, close]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {open ? <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={CLOSE_LABEL} importantForAccessibility="no" testID="composer-menu-outside" /> : null}
      <GrowSheet open={open} origin="left bottom" style={[styles.slot, { bottom }]}>
        <Glass level="panel" backdrop={backdrop} radius={radius.l + space.s} rim style={styles.panel}>
          {page === 'main' ? (
            <MainPage attach={attach} voice={voice} onClose={close} onCommands={() => setPage('commands')} />
          ) : (
            <CommandsPage
              load={loadCommands}
              onBack={() => setPage('main')}
              onPick={(c) => {
                close();
                onCommand(c);
              }}
            />
          )}
        </Glass>
      </GrowSheet>
    </View>
  );
}

const MainPage = memo(function MainPage({ attach, voice, onClose, onCommands }: { attach: AttachmentsModel; voice: VoiceModel; onClose: () => void; onCommands: () => void }) {
  const picking = useStore(attach.store, selectPicking);
  const canTalk = useStore(voice.store, selectCanTalk);
  const idle = useStore(voice.store, selectIdle);
  const first = useFocusOnMount();
  const add = (source: 'camera' | 'library' | 'audio') => {
    onClose();
    void attach.add(source);
  };
  return (
    <View accessibilityRole="menu" style={styles.list}>
      <Row ref={first} icon="camera-outline" label="Camera" onPress={() => add('camera')} disabled={picking} />
      <Row icon="image-outline" label="Gallery" onPress={() => add('library')} disabled={picking} />
      <Row icon="file-music-outline" label="Audio file" onPress={() => add('audio')} disabled={picking} />
      {canTalk ? (
        <Row
          icon="microphone-outline"
          label="Record"
          hint="Talk to EDITH"
          onPress={() => {
            onClose();
            void voice.start();
          }}
          disabled={!idle}
        />
      ) : null}
      <Row icon="console-line" label="Commands" hint="Compact, status and other commands" onPress={onCommands} more />
    </View>
  );
});

function CommandsPage({ load, onBack, onPick }: { load: () => Promise<Command[]>; onBack: () => void; onPick: (c: Command) => void }) {
  const [list, setList] = useState<Command[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load().then(
      (l) => live && setList(l),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);
  const first = useFocusOnMount();
  const { accent } = useTheme();
  return (
    <View style={styles.list}>
      <Row ref={first} icon="chevron-left" label="Commands" a11yLabel="Back to the menu" onPress={onBack} header />
      {list ? (
        <ScrollView style={styles.commands} keyboardShouldPersistTaps="handled" accessibilityRole="menu">
          {list.length ? (
            list.map((c) => <CommandRow key={c.name} command={c} onPick={onPick} />)
          ) : (
            <Text style={styles.note}>No commands on this server.</Text>
          )}
        </ScrollView>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.note}>Couldn't load the commands: {error}</Text>
          <Row icon="refresh" label="Try again" onPress={() => setAttempt((a) => a + 1)} />
        </View>
      ) : (
        <ActivityIndicator style={styles.center} color={accent} accessibilityLabel="Loading the commands" />
      )}
    </View>
  );
}

const CommandRow = memo(function CommandRow({ command: c, onPick }: { command: Command; onPick: (c: Command) => void }) {
  return (
    <Squish
      onPress={() => onPick(c)}
      style={styles.command}
      accessibilityRole="menuitem"
      accessibilityLabel={`/${c.name}`}
      accessibilityHint={needsArgs(c) ? `${c.description}. Puts it in the message box to finish` : c.description || undefined}
    >
      <Text style={styles.commandName}>/{c.name}</Text>
      {c.description ? (
        <Text style={styles.commandText} numberOfLines={1}>
          {c.description}
        </Text>
      ) : null}
    </Squish>
  );
});

/** TalkBack's focus goes to the page's first row when it opens (a ref for that row). */
function useFocusOnMount(): RefObject<View | null> {
  const first = useRef<View>(null);
  useEffect(() => {
    if (first.current) AccessibilityInfo.sendAccessibilityEvent(first.current, 'focus');
  }, []);
  return first;
}

function Row({
  ref,
  icon,
  label,
  a11yLabel,
  hint,
  onPress,
  disabled,
  more,
  header,
}: {
  ref?: Ref<View>;
  icon: string;
  label: string;
  a11yLabel?: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  more?: boolean; // opens a second page
  header?: boolean;
}) {
  return (
    <Squish
      ref={ref}
      onPress={onPress}
      disabled={disabled}
      style={[styles.row, header && styles.header, disabled && styles.disabled]}
      accessibilityRole={header ? 'button' : 'menuitem'}
      accessibilityLabel={a11yLabel ?? label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
    >
      <Icon name={icon} size={24} color={colors.text} halo />
      <Text style={[styles.label, header && styles.headerLabel]}>{label}</Text>
      {more ? <Icon name="chevron-right" size={20} color={colors.textSecondary} halo /> : null}
    </Squish>
  );
}

const ROW = 52;

const styles = StyleSheet.create({
  slot: { position: 'absolute', left: space.m, width: 240 },
  panel: { paddingVertical: space.s },
  list: { paddingHorizontal: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.l, minHeight: ROW, paddingHorizontal: space.m, borderRadius: radius.m },
  header: { minHeight: ROW - space.s },
  disabled: { opacity: 0.45 },
  // Text and icons at full opacity, a little heavier, each with the dark halo (legibleText): the
  // popup is clear glass with no pane behind them (core/theme/__tests__/contrast.test.ts).
  label: { color: colors.text, fontSize: type.size.title, fontWeight: '600', flex: 1, ...legibleText },
  headerLabel: { fontWeight: '700' },
  commands: { maxHeight: 6 * ROW },
  command: { minHeight: ROW, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.m },
  commandName: { color: colors.text, fontSize: type.size.body, fontWeight: '700', fontFamily: type.mono, ...legibleText },
  commandText: { color: colors.textSecondary, fontSize: type.size.small, fontWeight: '500', ...legibleText },
  note: { color: colors.textSecondary, fontSize: type.size.small, fontWeight: '500', paddingHorizontal: space.m, paddingVertical: space.s, ...legibleText },
  center: { paddingVertical: space.l },
});
