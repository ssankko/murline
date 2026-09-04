// The PDMX archive is fetched and unpacked by a job the Rust side owns, which keeps going after
// the settings panel closes. Where that job stands is therefore read from Rust and never
// remembered here: a mount asks for the status, and the job's two events keep the answer current.

import { commands, type PdmxStatus } from '@/bindings';
import { on } from '@/rust';
import { useEffect, useState } from 'react';

const MB = 1e6;
const GB = 1e9;

/** A running download as one line: "0.8 of 1.9 GB", or "812 MB" when the size is not declared. */
export function progressLabel({ done, total }: { done: number; total: number | null }): string {
  // The unit comes from the whole download, so the number climbs without the unit changing under it.
  const gb = (total ?? done) >= GB;
  const amount = (bytes: number) => (gb ? (bytes / GB).toFixed(1) : String(Math.round(bytes / MB)));
  const unit = gb ? 'GB' : 'MB';
  return total === null ? `${amount(done)} ${unit}` : `${amount(done)} of ${amount(total)} ${unit}`;
}

/** The PDMX job as it stands, `null` until the Rust side has answered, and the two ways to move it. */
export interface Pdmx {
  status: PdmxStatus | null;
  /** Downloads and unpacks the archive, or joins the download already running. */
  start: () => void;
  /** Asks Rust to stop the running fetch, whichever window started it. */
  cancel: () => void;
}

/** Rebuilds from the status on mount, and follows the job through its events while on screen. */
export function usePdmx(): Pdmx {
  const [status, setStatus] = useState<PdmxStatus | null>(null);

  useEffect(() => {
    let live = true;
    const hold = (next: PdmxStatus) => {
      if (live) setStatus(next);
    };
    void commands.pdmxStatus().then(hold, () => {});
    // A progress message carries only the two numbers, so what is on disk is kept as it stood.
    const stop = [
      on('pdmxProgress', ({ done, total }) =>
        setStatus((was) => ({
          ready: was?.ready ?? false,
          running: true,
          done,
          total,
          error: null,
        })),
      ),
      on('pdmxDone', hold),
    ];
    return () => {
      live = false;
      for (const one of stop) one();
    };
  }, []);

  return {
    status,
    start: () => void commands.pdmxFetch().then(setStatus, () => {}),
    cancel: () => void commands.pdmxCancel().catch(() => {}),
  };
}
