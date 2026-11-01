// usePageBack: a page takes Android back first (core/pageBack.ts). Inside a screen that provides the
// context (Settings), the screen asks it before leaving the page; anywhere else (tests, a screen
// without one) it gets the press straight from BackHandler.

import { useContext, useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

import { PageBackContext, type PageBack } from '../core/pageBack';

/** Ask `handler` first when Android back is pressed while this page shows (the latest handler wins). */
export function usePageBack(handler: PageBack): void {
  const ctx = useContext(PageBackContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const ask = () => latest.current();
    if (ctx) {
      ctx.set(ask);
      return () => ctx.set(null);
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', ask);
    return () => sub.remove();
  }, [ctx]);
}
