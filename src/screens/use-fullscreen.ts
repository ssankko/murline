// The window's fullscreen state: macOS hides its traffic lights in fullscreen, and the top bars
// answer by folding away the gap kept for them.

import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';

/**
 * Whether the window is fullscreen now. Entering and leaving fullscreen resizes the window, so the
 * resize event is when the state is read again. Outside Tauri — a plain browser, a test — there is
 * no window to ask and the answer stays false.
 */
export function useFullscreen(): boolean {
  const [full, setFull] = useState(false);
  useEffect(() => {
    // `getCurrentWindow` reads the internals only a Tauri webview carries.
    if (!('__TAURI_INTERNALS__' in window)) return;
    let live = true;
    const read = async (): Promise<void> => {
      const now = await getCurrentWindow().isFullscreen();
      if (live) setFull(now);
    };
    void read();
    const stop = getCurrentWindow().onResized(() => void read());
    return () => {
      live = false;
      void stop.then((off) => off(), console.error);
    };
  }, []);
  return full;
}
