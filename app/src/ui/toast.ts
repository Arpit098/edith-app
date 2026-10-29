import { ToastAndroid } from 'react-native';

/** A short Android toast; empty text shows nothing. */
export function toast(text: string | null | undefined): void {
  if (text) ToastAndroid.show(text, text.length > 60 ? ToastAndroid.LONG : ToastAndroid.SHORT);
}
