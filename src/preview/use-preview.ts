// The one read of a Preview React makes: everything the screen draws arrives as one object, and a
// change to any of it re-renders. Nothing else of the Preview reaches a component.

import { NO_PREVIEW, type Preview, type PreviewShown } from '@/preview/preview';
import { useCallback, useSyncExternalStore } from 'react';

/** What the Preview draws now, or the empty Preview while a piece is still opening. */
export function usePreview(preview: Preview | null): PreviewShown {
  return useSyncExternalStore(
    useCallback((listen: () => void) => preview?.subscribe(listen) ?? (() => {}), [preview]),
    useCallback(() => preview?.snapshot() ?? NO_PREVIEW, [preview]),
  );
}
