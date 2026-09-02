// The PDMX archive is fetched and unpacked by Rust, which keeps going after the settings dialog
// closes. Its progress therefore lives here, outside React, so reopening the dialog picks the
// running download back up.

import { reasonOf } from '@/library/notice';
import { makeStore } from '@/lib/store';
import { commands, type PdmxProgress } from '@/bindings';
import { Channel } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';

export interface PdmxDownload {
  /** Non-null while the archive is downloading. */
  progress: PdmxProgress | null;
  /** Why the last download stopped, cleared by a new one. A cancel leaves it null. */
  error: string | null;
}

const MB = 1e6;
const GB = 1e9;

/** The running download as one line: "0.8 of 1.9 GB", or "812 MB" when the size is not declared. */
export function progressLabel({ done, total }: PdmxProgress): string {
  // The unit comes from the whole archive, so the number climbs without the unit changing under it.
  const gb = (total ?? done) >= GB;
  const amount = (bytes: number) => (gb ? (bytes / GB).toFixed(1) : String(Math.round(bytes / MB)));
  const unit = gb ? 'GB' : 'MB';
  return total === null ? `${amount(done)} ${unit}` : `${amount(done)} of ${amount(total)} ${unit}`;
}

const download = makeStore<PdmxDownload>({ progress: null, error: null });

/** Downloads and unpacks the PDMX archive into the folder the Rust side keeps it in. */
export async function downloadPdmx(): Promise<void> {
  if (download.get().progress) return;
  download.set({ progress: { done: 0, total: null }, error: null });
  try {
    const progress = new Channel<PdmxProgress>();
    progress.onmessage = (at) => download.set({ progress: at, error: null });
    await commands.pdmxFetch(progress);
    download.set({ progress: null, error: null });
  } catch (error) {
    const reason = reasonOf(error);
    // A cancel is the user's own doing, so it says nothing and returns to the idle state.
    download.set({ progress: null, error: reason === 'cancelled' ? null : reason });
  }
}

/** Asks Rust to stop; the download then rejects with "cancelled". */
export function cancelPdmx(): void {
  commands.pdmxCancel().catch(() => {});
}

/** The download as it stands, for as long as the component asking is on screen. */
export function usePdmxDownload(): PdmxDownload {
  return useSyncExternalStore(download.subscribe, download.get);
}
