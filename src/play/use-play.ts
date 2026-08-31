// The one read of a play React makes: everything the screen draws arrives as one object, and a
// change to any of it re-renders. Nothing else of the play reaches a component.

import { NO_PLAY, type Play, type PlayShown } from '@/play/play';
import { useCallback, useSyncExternalStore } from 'react';

/** What the play draws now, or the empty play while a piece is still opening. */
export function usePlay(play: Play | null): PlayShown {
  return useSyncExternalStore(
    useCallback((listen: () => void) => play?.subscribe(listen) ?? (() => {}), [play]),
    useCallback(() => play?.snapshot() ?? NO_PLAY, [play]),
  );
}
