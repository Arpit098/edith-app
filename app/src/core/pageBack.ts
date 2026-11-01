// Android back on a page inside a screen (a Settings page): the page may handle it first, e.g. to
// close a sheet it shows, before the screen takes it to leave the page. The screen provides this
// context and asks the page's handler first (ui/pageBack.ts has the hook pages use).

import { createContext } from 'react';

/** True when the press was handled (nothing else should act on it). */
export type PageBack = () => boolean;

export const PageBackContext = createContext<{ set(handler: PageBack | null): void } | null>(null);
