import { getSettingOr, readSettings } from '@/db/db';
import { setTheme } from '@/look/use-dark';
import type { PlayKind } from '@/play/engine';
import { Library } from '@/screens/library';
import { Onboarding } from '@/screens/onboarding';
import { PlayScreen } from '@/screens/play';
import { PreviewScreen } from '@/screens/preview';
import { useEffect, useState } from 'react';

type Route =
  | { at: 'loading' }
  | { at: 'onboarding' }
  | { at: 'library'; folder: string | null; selected?: string }
  | { at: 'preview'; folder: string; path: string }
  | { at: 'play'; folder: string; path: string; intent: PlayKind };

export function App() {
  const [route, setRoute] = useState<Route>({ at: 'loading' });

  // The theme is global, so it is painted before any screen is. A database that will not open
  // reads as unfinished onboarding, which reports the failure when Continue retries it.
  useEffect(() => {
    void readSettings().then((s) => {
      setTheme(s.theme);
      setRoute(
        s.onboarding_done
          ? { at: 'library', folder: s.library_folder || null }
          : { at: 'onboarding' },
      );
    });
  }, []);

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
