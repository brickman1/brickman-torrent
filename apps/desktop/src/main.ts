import './styles.css';
import { createMockProvider } from './core/mock-provider';
import { loadSettings, normalizeSettings } from './core/settings';
import type { TorrentProvider } from './core/provider';
import type { AppSettings } from './core/types';
import { App } from './ui/app';
import { t } from './i18n';

const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;

/**
 * Settings the store already has, read before the engine is created: the
 * engine takes the download folder and the listener options (UPnP, uTP) at
 * creation, so they must not start as defaults. `loadSettings` below reads the
 * same store through the provider for the UI.
 */
async function storedSettings(): Promise<AppSettings> {
  if (!isTauri()) return normalizeSettings(null);
  try {
    const { readStoredSettings } = await import('./core/tauri-provider');
    return normalizeSettings(await readStoredSettings());
  } catch (err) {
    console.warn('[brickman-torrent] cannot read the stored settings', err);
    return normalizeSettings(null);
  }
}

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

/**
 * The tray menu of the desktop shell; `pause-all` is the only action it sends
 * back to the window. The listener lives with the provider, so it is set up
 * once both exist.
 */
async function subscribeTrayActions(app: App): Promise<void> {
  if (!isTauri()) return;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<string>('tray-action', (event) => {
      if (event.payload !== 'pause-all') return;
      void app
        .pauseAll()
        .catch((err: unknown) => console.warn('[brickman-torrent] cannot pause all', err));
    });
  } catch (err) {
    console.warn('[brickman-torrent] cannot listen to the tray actions', err);
  }
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app element is missing');

  // The engine is created with the stored folder and listener options; the
  // settings the UI works with are then read through the provider.
  const provider = await resolveProvider(await storedSettings());
  const settings = await loadSettings(provider);

  const app = new App(root, provider, settings);
  // Debug handles: the UI for a quick look in the console, and the provider so
  // the smoke test can drive the mock engine (clipboard, incoming links).
  (window as unknown as { __torrentUI?: App }).__torrentUI = app;
  (window as unknown as { __torrentProvider?: TorrentProvider }).__torrentProvider = provider;
  await app.init();
  await subscribeTrayActions(app);

  // The tray texts are native, so they are pushed after the locale is applied.
  try {
    await provider.setTrayLabels?.(t('tray.show'), t('tray.pauseAll'), t('tray.quit'));
  } catch (err) {
    console.warn('[brickman-torrent] cannot set the tray labels', err);
  }
}

void bootstrap().catch((error: unknown) => {
  console.error('[brickman-torrent] bootstrap failed', error);
  const root = document.getElementById('app');
  if (root) {
    root.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
  }
});
