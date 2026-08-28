import { App } from '@/App';
import '@/index.css';
import { installTauriMock, watchBoot } from '@/dev/tauri-mock';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The address ?mocktauri runs the app in a plain browser on a faked Tauri runtime, with the boot
// under frame-by-frame watch, so the boot screen can be studied without `tauri dev`.
if (import.meta.env.DEV && location.search.includes('mocktauri')) {
  installTauriMock();
  watchBoot();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
