import './styles.css';
import { createMockProvider } from './core/mock-provider';
import { loadSettings } from './core/settings';
import type { TorrentProvider } from './core/provider';
import type { AppSettings } from './core/types';
import { App } from './ui/app';

const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;

async function resolveProvider(settings: AppSettings): Promise<TorrentProvider> {
  // Plain browser (npm run dev): mock provider, no Tauri code is loaded at all.
  if (!isTauri()) return createMockProvider();

  // Inside the webview: the real adapter creates the engine with the download
  // folder and the connection settings (UPnP, uTP, peer limit, trackers). The
  // mock stays as a fallback, so the window is never empty if the engine
  // cannot start.
  try {
    const tauriProvider = await import('./core/tauri-provider').then((module) =>
      module.createTauriProvider({
        downloadDir: settings.downloadDir,
        connections: {
          upnpEnabled: settings.upnpEnabled,
          utpEnabled: settings.utpEnabled,
          peerLimit: settings.peerLimit,
          extraTrackers: settings.extraTrackers,
        },
      }),
    );
    await tauriProvider.list();
    return tauriProvider;
  } catch (err) {
    console.warn('[brickman-torrent] engine is not available, falling back to mock data', err);
    return createMockProvider();
  }
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app element is missing');

  // Settings are read first: the Tauri provider needs the download folder and
  // the connection settings to create the engine.
  const settings = loadSettings();
  const provider = await resolveProvider(settings);

  const app = new App(root, provider, settings);
  // Debug handles: the UI for a quick look in the console, and the provider so
  // the smoke test can drive the mock engine (clipboard, incoming links).
  (window as unknown as { __torrentUI?: App }).__torrentUI = app;
  (window as unknown as { __torrentProvider?: TorrentProvider }).__torrentProvider = provider;
  await app.init();
}

void bootstrap().catch((error: unknown) => {
  console.error('[brickman-torrent] bootstrap failed', error);
  const root = document.getElementById('app');
  if (root) {
    root.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
  }
});
