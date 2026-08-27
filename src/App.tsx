import { getSetting, getSettingOr, SETTING_DEFAULTS } from '@/db/db';
import { setTheme } from '@/look/use-dark';
import { Library } from '@/screens/library';
import { Onboarding } from '@/screens/onboarding';
import { PlayScreen, type PlayIntent } from '@/screens/play';
import { PreviewScreen } from '@/screens/preview';
import { useEffect, useState } from 'react';

type Route =
  | { at: 'loading' }
  | { at: 'onboarding' }
  | { at: 'library'; folder: string | null; selected?: string }
  | { at: 'preview'; folder: string; path: string }
  | { at: 'play'; folder: string; path: string; intent: PlayIntent };

export function App() {
  const [route, setRoute] = useState<Route>({ at: 'loading' });

  // The theme is global, so it is painted before any screen is.
  useEffect(() => {
    void getSettingOr('theme', SETTING_DEFAULTS.theme).then(setTheme);
  }, []);

  // A database that will not open leaves onboarding to report the failure when Continue retries it.
  useEffect(() => {
    Promise.all([getSetting('onboarding_done'), getSetting('library_folder')]).then(
      ([done, folder]) => setRoute(done ? { at: 'library', folder } : { at: 'onboarding' }),
      () => setRoute({ at: 'onboarding' }),
    );
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
          onBack={() => setRoute({ at: 'library', folder: route.folder, selected: route.path })}
        />
      );
  }
}
