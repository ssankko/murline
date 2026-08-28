import { BEAT_MS, EASE_CURVE, LogLine, usePacedLines } from '@/boot-pacing';
import { boot, lineText, START_LINE, type BootLine } from '@/boot';
import { getSettingOr, type Settings } from '@/db/db';
import { Loading } from '@/look/loading';
import { reducedMotion } from '@/look/motion';
import type { PlayKind } from '@/play/engine';
import { Library } from '@/screens/library';
import { Onboarding } from '@/screens/onboarding';
import { PlayScreen } from '@/screens/play';
import { PreviewScreen } from '@/screens/preview';
import { useEffect, useRef, useState } from 'react';

type Route =
  | { at: 'loading' }
  | { at: 'onboarding' }
  | { at: 'library'; folder: string | null; selected?: string }
  | { at: 'preview'; folder: string; path: string }
  | { at: 'play'; folder: string; path: string; intent: PlayKind };

/** How long the boot screen's leave takes. */
const EXIT_MS = 200;

export function App() {
  const [route, setRoute] = useState<Route>({ at: 'loading' });
  // The log starts with the line index.html paints, so React's first frame shows the same screen.
  const [lines, setLines] = useState<BootLine[]>([START_LINE]);
  const [booted, setBooted] = useState<Settings | null>(null);
  const [fading, setFading] = useState(false);
  const [finalLines, setFinalLines] = useState<BootLine[]>([START_LINE]);
  const { shown, drained } = usePacedLines(lines, BEAT_MS);
  const layer = useRef<HTMLDivElement>(null);
  const flipped = useRef(false);

  // A database that will not open reads as unfinished onboarding, which reports the failure when
  // Continue retries it. Two boot runs print the same lines, so the last array to land is right.
  useEffect(() => {
    void boot(setLines).then(setBooted);
  }, []);

  // The route flips once: StrictMode runs boot twice in dev, and a second resolve must not re-arm
  // the handover, or the boot layer rises over the library again after it has gone. The flip waits
  // for the last shown line and freezes the log it fades with, so a late print from the second run
  // cannot change what the layer holds. The handover fades, unless motion is turned down, in which
  // case the screens swap in place.
  useEffect(() => {
    if (!booted || !drained || flipped.current) return;
    flipped.current = true;
    setFinalLines(shown);
    setRoute(
      booted.onboarding_done
        ? { at: 'library', folder: booted.library_folder || null }
        : { at: 'onboarding' },
    );
    if (!reducedMotion()) setFading(true);
  }, [booted, drained, shown]);

  // The boot layer holds one React identity from the first line to the end of the fade, so the
  // log never remounts and its entrances never replay. At the flip the layer gains a paper
  // background over the screen underneath and dissolves; done, it leaves.
  useEffect(() => {
    if (!fading) return;
    const cover = layer.current;
    if (!cover) return;
    const fade = cover.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: EXIT_MS,
      easing: EASE_CURVE,
      // The finished animation holds its last frame: without a fill the layer would snap back to
      // full opacity for the frames before the unmount commits.
      fill: 'forwards',
    });
    fade.onfinish = () => setFading(false);
    return () => fade.cancel();
  }, [fading]);

  return (
    <>
      {route.at !== 'loading' && screenOf(route, setRoute)}
      {(route.at === 'loading' || fading) && (
        <div
          ref={layer}
          style={
            route.at === 'loading'
              ? undefined
              : {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 100,
                  background: 'var(--paper)',
                  pointerEvents: 'none',
                }
          }
        >
          <BootScreen lines={fading ? finalLines : shown} />
        </div>
      )}
    </>
  );
}

/** The screen a route names; the loading route names none, the boot layer stands in for it. */
function screenOf(route: Route, setRoute: (route: Route) => void) {
  switch (route.at) {
    case 'loading':
      return null;
    case 'onboarding':
      return <Onboarding onDone={(folder) => setRoute({ at: 'library', folder })} />;
    case 'library':
      return (
        <Library
          folder={route.folder}
          selected={route.selected}
          onFolder={(folder) => setRoute({ at: 'library', folder, selected: route.selected })}
          onPlay={(path, intent) => {
            if (route.folder) setRoute({ at: 'play', folder: route.folder, path, intent });
          }}
          onPreview={(path) => {
            if (route.folder) setRoute({ at: 'preview', folder: route.folder, path });
          }}
        />
      );
    case 'preview':
      return (
        <PreviewScreen
          folder={route.folder}
          path={route.path}
          onBack={() => setRoute({ at: 'library', folder: route.folder, selected: route.path })}
          onPlay={(intent) =>
            setRoute({ at: 'play', folder: route.folder, path: route.path, intent })
          }
        />
      );
    case 'play':
      return (
        <PlayScreen
          folder={route.folder}
          path={route.path}
          intent={route.intent}
          onBack={() =>
            // The library folder may have moved in the settings dialog while the piece was open.
            void getSettingOr('library_folder', route.folder).then((folder) =>
              setRoute({ at: 'library', folder, selected: route.path }),
            )
          }
        />
      );
  }
}

/** The start-up log: a step's line is on screen from the moment the step begins. Its look and its
 * first line live in index.html. */
function BootScreen({ lines }: { lines: BootLine[] }) {
  return (
    <pre className="boot">
      {lines.map((line, at) => (
        <LogLine key={at} text={`${lineText(line)}\n`} enters={at > 0} />
      ))}
      <Loading on label="Starting" />
    </pre>
  );
}
