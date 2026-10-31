// First run (or after "Change server"): the App API address and token.

import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Connection } from '../core/connection';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { colors, type, radius, space, useTheme } from '../core/theme';

export function ConnectScreen({ connection }: { connection: Connection }) {
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState(() => connection.store.get().baseUrl ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => connection.store.get().error);

  const connect = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    connection.connect(address, token).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }); // on success the shell swaps this screen out
  };

  const theme = useTheme();
  return (
    <KeyboardAvoidingView style={[styles.flex, { backgroundColor: theme.bg }]} behavior="padding">
      <ScrollView contentContainerStyle={[styles.body, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
        <View style={styles.logo}>
          <Icon name="robot-happy-outline" size={56} color={theme.accent} />
          <Text style={styles.title}>Connect to EDITH</Text>
          <Text style={styles.sub}>Over Tailscale. The token stays on this phone, encrypted with the Android Keystore.</Text>
        </View>

        <Text style={styles.label}>Server address</Text>
        <TextInput
          style={styles.input}
          value={address}
          onChangeText={setAddress}
          placeholder="edith:8787 or 100.x.y.z:8787"
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="next"
          accessibilityLabel="Server address"
        />

        <Text style={styles.label}>Token</Text>
        <TextInput
          style={[styles.input, styles.mono]}
          value={token}
          onChangeText={setToken}
          placeholder="from ~/.config/edith/app-token on edith"
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={connect}
          accessibilityLabel="Token"
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.action}>
          <Button label="Connect" icon="lan-connect" variant="primary" onPress={connect} busy={busy} disabled={!address.trim() || !token.trim()} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { paddingHorizontal: space.xl, gap: space.s },
  logo: { alignItems: 'center', gap: space.s, marginBottom: space.xl },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  sub: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  label: { color: colors.textDim, fontSize: 13, marginTop: space.m },
  input: { color: colors.text, backgroundColor: colors.card, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.m, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  mono: { fontFamily: type.mono },
  error: { color: colors.danger, fontSize: 14, marginTop: space.m },
  action: { marginTop: space.xl },
});
