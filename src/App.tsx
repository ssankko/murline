import { getSetting } from '@/db/db';
import { Library } from '@/screens/library';
import { Onboarding } from '@/screens/onboarding';
import { useEffect, useState } from 'react';

type Route = { at: 'loading' } | { at: 'onboarding' } | { at: 'library'; folder: string | null };

export function App() {
  const [route, setRoute] = useState<Route>({ at: 'loading' });

  useEffect(() => {
    Promise.all([getSetting('onboarding_done'), getSetting('library_folder')]).then(
      ([done, folder]) => setRoute(done ? { at: 'library', folder } : { at: 'onboarding' }),
    );
  }, []);

  switch (route.at) {
    case 'loading':
      return null;
    case 'onboarding':
      return <Onboarding onDone={(folder) => setRoute({ at: 'library', folder })} />;
    case 'library':
      return <Library folder={route.folder} />;
  }
}
