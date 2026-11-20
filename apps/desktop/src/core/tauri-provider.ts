// Tauri adapter: maps the provider interface 1:1 onto the Rust commands in
// `src-tauri/src/lib.rs` (camelCase arguments).

import type { TorrentProvider } from './provider';
import type {
  FilePriority,
  PeerInfo,
  SessionStats,
  Torrent,
  TorrentFile,
  TrackerInfo,
  UpdateInfo,
} from './types';
import { APP_VERSION } from './version';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface TauriProviderOptions {
  /** Download folder from the UI settings; empty = system default. */
  downloadDir?: string;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function createTauriProvider(
  options: TauriProviderOptions = {},
): Promise<TorrentProvider> {
  const { invoke } = await import('@tauri-apps/api/core');
  const call = invoke as Invoke;

  // The engine is created once, here, with the download folder from settings.
  await call<void>('engine_init', { downloadDir: options.downloadDir ?? null });

  const provider: TorrentProvider = {
    kind: 'tauri',

    list: () => call<Torrent[]>('list_torrents'),
    stats: () => call<SessionStats>('get_session_stats'),

    addFile: (name) => call<Torrent>('add_torrent_file', { name: name ?? null }),
    addMagnet: (uri) => call<Torrent>('add_magnet', { uri: uri ?? null }),

    start: (ids) => call<void>('resume_torrents', { ids }),
    pause: (ids) => call<void>('pause_torrents', { ids }),
    stop: (ids) => call<void>('stop_torrents', { ids }),
    remove: (ids, deleteData) => call<void>('remove_torrents', { ids, deleteData }),
    moveTo: (id, index) => call<void>('move_torrent', { id, index }),
    moveBy: (id, delta) => call<void>('move_torrent_by', { id, delta }),
    setMaxActive: (maxActive) => call<void>('set_max_active', { maxActive }),
    setLimits: (limits) => call<void>('set_limits', { ...limits }),
    setDownloadDir: (dir) => call<void>('set_download_dir', { dir }),

    files: (id) => call<TorrentFile[]>('list_files', { id }),
    setFilePriority: (id, fileId, priority: FilePriority) =>
      call<void>('set_file_priority', { id, fileId, priority }),
    trackers: (id) => call<TrackerInfo[]>('list_trackers', { id }),
    peers: (id) => call<PeerInfo[]>('list_peers', { id }),

    checkForUpdates: () => call<UpdateInfo>('check_for_updates'),

    openExternal: async (url: string) => {
      await call<void>('open_external', { url });
    },
  };

  // Keep the version used by the update dialog in sync with the crate version.
  console.info('[brickman-torrent] tauri provider ready, app version', APP_VERSION);
  return provider;
}
