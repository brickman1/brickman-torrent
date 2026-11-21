// Tauri adapter: maps the provider interface 1:1 onto the Rust commands in
// `src-tauri/src/lib.rs` (camelCase arguments).

import type { TorrentProvider } from './provider';
import type {
  AddTorrentOptions,
  ConnectionChange,
  ConnectionSettings,
  FilePriority,
  HandlerStatus,
  LinkPayload,
  OutputDirChange,
  PeerInfo,
  PowerSettings,
  PowerStatus,
  SessionStats,
  Torrent,
  TorrentFile,
  TorrentPreview,
  TrackerInfo,
  UpdateInfo,
} from './types';
import { APP_VERSION } from './version';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Event the Rust side uses to hand a link or a `.torrent` file to the window. */
const LINK_EVENT = 'link-received';

export interface TauriProviderOptions {
  /** Download folder from the UI settings; empty = system default. */
  downloadDir?: string;
  /** "Connections" settings: they shape the engine's listener at startup. */
  connections?: ConnectionSettings;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function createTauriProvider(
  options: TauriProviderOptions = {},
): Promise<TorrentProvider> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const call = invoke as Invoke;

  // The listener has to exist before `engine_init`: that command flushes the
  // links of the first launch (a `magnet:` argument of this very process), and
  // an event emitted without a listener is lost. Links that arrive before the
  // window subscribes are kept and handed over by `onLinkReceived`.
  const buffered: LinkPayload[] = [];
  let onLink: ((payload: LinkPayload) => void) | null = null;
  const stopListening = await listen<LinkPayload>(LINK_EVENT, (event) => {
    const payload = event.payload;
    if (onLink) onLink(payload);
    else buffered.push(payload);
  });

  // The engine is created once, here, with the download folder and the
  // connection settings. UPnP and uTP are listener options: they are only read
  // at this point, a later change needs a restart (the UI says so).
  await call<void>('engine_init', {
    downloadDir: options.downloadDir ?? null,
    connections: connectionArgs(options.connections),
  });

  const provider: TorrentProvider = {
    kind: 'tauri',

    list: () => call<Torrent[]>('list_torrents'),
    stats: () => call<SessionStats>('get_session_stats'),

    addFile: (name, addOptions) =>
      call<Torrent>('add_torrent_file', { name: name ?? null, ...addArgs(addOptions) }),
    addMagnet: (uri, addOptions) =>
      call<Torrent>('add_magnet', { uri: uri ?? null, ...addArgs(addOptions) }),
    previewFile: (name) => call<TorrentPreview>('preview_torrent_file', { name }),
    stageDroppedTorrent: (name, bytes) =>
      call<string>('stage_torrent_file', { name, bytes: Array.from(bytes) }),

    pickTorrentFile: () => call<string | null>('pick_torrent_file'),
    pickFolder: () => call<string | null>('pick_directory'),
    firstDirectory: (paths) => call<string | null>('first_directory', { paths }),

    validateDir: (dir) => call<void>('validate_download_dir', { path: dir }),
    defaultDownloadDir: () => call<string>('default_download_folder'),
    openFolder: (target) =>
      call<void>('open_folder', { id: target.id ?? null, path: target.path ?? null }),
    setTorrentOutputDir: (id, dir) => call<OutputDirChange>('set_torrent_output_dir', { id, dir }),

    start: (ids) => call<void>('resume_torrents', { ids }),
    pause: (ids) => call<void>('pause_torrents', { ids }),
    stop: (ids) => call<void>('stop_torrents', { ids }),
    remove: (ids, deleteData) => call<void>('remove_torrents', { ids, deleteData }),
    moveTo: (id, index) => call<void>('move_torrent', { id, index }),
    moveBy: (id, delta) => call<void>('move_torrent_by', { id, delta }),
    setMaxActive: (maxActive) => call<void>('set_max_active', { maxActive }),
    setLimits: (limits) => call<void>('set_limits', { ...limits }),
    setConnectionSettings: (settings) =>
      call<ConnectionChange>('set_connection_settings', {
        connections: connectionArgs(settings),
      }),
    setDownloadDir: (dir) => call<void>('set_download_dir', { dir }),

    files: (id) => call<TorrentFile[]>('list_files', { id }),
    setFilePriority: (id, fileId, priority: FilePriority) =>
      call<void>('set_file_priority', { id, fileId, priority }),
    trackers: (id) => call<TrackerInfo[]>('list_trackers', { id }),
    peers: (id) => call<PeerInfo[]>('list_peers', { id }),

    checkForUpdates: () => call<UpdateInfo>('check_for_updates'),

    powerStatus: () => call<PowerStatus>('get_power_status'),
    setPowerSettings: (settings: PowerSettings) =>
      call<PowerStatus>('set_power_settings', {
        action: settings.action,
        delaySecs: settings.delaySecs,
      }),
    cancelPowerOff: () => call<PowerStatus>('cancel_power_off'),

    openExternal: async (url: string) => {
      await call<void>('open_external', { url });
    },

    handlerStatus: () => call<HandlerStatus>('handler_status'),
    handlerRegister: () => call<HandlerStatus>('handler_register'),
    handlerUnregister: () => call<HandlerStatus>('handler_unregister'),
    openDefaultApps: () => call<void>('open_default_apps'),

    readClipboard: () => call<string | null>('read_clipboard'),

    onLinkReceived: (handler) => {
      onLink = handler;
      for (const payload of buffered.splice(0)) handler(payload);
      return () => {
        if (onLink === handler) onLink = null;
      };
    },

    // The window owns the listener for its lifetime: the only thing to undo is
    // the delivery, so a link arriving while the page unloads is not handled.
    disconnect: () => {
      onLink = null;
      buffered.length = 0;
      void stopListening();
    },
  };

  // Keep the version used by the update dialog in sync with the crate version.
  console.info('[brickman-torrent] tauri provider ready, app version', APP_VERSION);
  return provider;
}

/** The add commands take the per-add choices as flat camelCase arguments. */
function addArgs(options?: AddTorrentOptions): Record<string, unknown> {
  return {
    outputDir: options?.outputDir?.trim() || null,
    createSubfolder: options?.createSubfolder ?? null,
    startPaused: options?.startPaused ?? null,
  };
}

/** "Connections" block as the Rust command expects it (camelCase fields). */
function connectionArgs(settings?: ConnectionSettings): Record<string, unknown> | null {
  if (!settings) return null;
  return {
    upnpEnabled: settings.upnpEnabled,
    utpEnabled: settings.utpEnabled,
    peerLimit: settings.peerLimit,
    extraTrackers: settings.extraTrackers,
  };
}
