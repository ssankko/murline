import { Button } from '@/components/ui/button';
import { setSetting } from '@/db/db';
import { Input } from '@/components/ui/input';
import { useMidiStatus } from '@/midi/use-midi-status';
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';

/** First launch asks one question: which folder holds the scores. */
export function Onboarding({ onDone }: { onDone: (folder: string) => void }) {
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const midi = useMidiStatus();

  // A home directory the app cannot read leaves the field empty for the user to fill or choose.
  useEffect(() => {
    void homeDir().then((home) => setFolder(`${home}/Music/Piano`), () => {});
  }, []);

  async function choose() {
    const picked = await open({ directory: true, defaultPath: folder });
    if (typeof picked === 'string') setFolder(picked);
  }

  async function proceed() {
    // The field is free text and the folder is made exactly as typed, so a name the shell would
    // expand, such as ~/Music/Piano, would become a folder called "~" beside the app.
    if (!folder.startsWith('/')) {
      setError('Type the whole path, from the first /, or use Choose….');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await invoke('ensure_dir', { path: folder });
      await setSetting('library_folder', folder);
      await setSetting('onboarding_done', true);
      onDone(folder);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex w-[520px] flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Piano</h1>
          <p className="text-muted-ink text-[13px]">
            Pick the folder that holds your scores. The app reads and writes MusicXML files there
            and touches nothing else.
          </p>
        </div>

        <div className="flex gap-2">
          <Input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            spellCheck={false}
            aria-label="Library folder"
          />
          <Button variant="outline" onClick={() => void choose().catch((e: unknown) => setError(String(e)))}>
            Choose…
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-muted-ink text-[12px]">{midiLine(midi)}</p>
          <Button onClick={proceed} disabled={busy || folder.trim() === ''}>
            Continue
          </Button>
        </div>

        {error && <p className="text-[12px]">{error}</p>}
      </div>
    </div>
  );
}

function midiLine({ devices, error }: ReturnType<typeof useMidiStatus>): string {
  if (error) return `MIDI unavailable: ${error}`;
  if (devices.length === 0) return 'No MIDI device found, plug one in any time';
  return `${devices.join(', ')} connected`;
}
