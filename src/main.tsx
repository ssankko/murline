import { App } from '@/App';
import '@/index.css';
import { installTauriMock } from '@/dev/tauri-mock';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The address ?mocktauri runs the app in a plain browser on a faked Tauri runtime, so the screens
// can be studied without `tauri dev`.
if (import.meta.env.DEV && location.search.includes('mocktauri')) installTauriMock();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
