import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './theme/global.css';

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  'Failed to fetch dynamically imported module',
  'Importing a module script failed',
  'error loading dynamically imported module',
];

function recoverFromStaleChunk(reason: unknown) {
  const message = String(
    reason instanceof Error
      ? reason.message
      : (reason as { message?: unknown })?.message || reason || '',
  );
  if (!DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => message.includes(pattern))) return;

  const routeKey = `${window.location.pathname}${window.location.search}`;
  const storageKey = 'benlai.dynamic-import-reload-route';
  if (sessionStorage.getItem(storageKey) === routeKey) return;
  sessionStorage.setItem(storageKey, routeKey);
  window.location.reload();
}

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  recoverFromStaleChunk('Failed to fetch dynamically imported module');
});

window.addEventListener('unhandledrejection', (event) => {
  recoverFromStaleChunk(event.reason);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
