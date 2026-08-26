import { getSetting } from '@/db/db';
import { Library } from '@/screens/library';
import { Onboarding } from '@/screens/onboarding';
import { PlayScreen } from '@/screens/play';
import { useEffect, useState } from 'react';

type Route =
  | { at: 'loading' }
  | { at: 'onboarding' }
  | { at: 'library'; folder: string | null; selected?: string }
  | { at: 'play'; folder: string; path: string };

export function App() {
  const [route, setRoute] = useState<Route>({ at: 'loading' });

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
          onPractice={(path) => {
            if (route.folder) setRoute({ at: 'play', folder: route.folder, path });
          }}
        />
      );
    case 'play':
      return (
        <PlayScreen
          folder={route.folder}
          path={route.path}
          onBack={() => setRoute({ at: 'library', folder: route.folder, selected: route.path })}
        />
      );
  }
}
