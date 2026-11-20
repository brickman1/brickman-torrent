import type {
  FilePriority,
  PeerInfo,
  SessionStats,
  Torrent,
  TorrentFile,
  TrackerInfo,
  UpdateInfo,
} from './types';

/**
 * Everything the UI needs from the engine.
 *
 * Mock implementation: src/core/mock-provider.ts
 * Tauri implementation: src/core/tauri-provider.ts (1:1 command names below)
 */
export interface TorrentProvider {
  readonly kind: 'mock' | 'tauri';

  /** Polled every second by the UI. */
  list(): Promise<Torrent[]>;
  stats(): Promise<SessionStats>;

  addFile(name?: string): Promise<Torrent>;
  addMagnet(uri?: string): Promise<Torrent>;

  start(ids: string[]): Promise<void>;
  pause(ids: string[]): Promise<void>;
  stop(ids: string[]): Promise<void>;
  remove(ids: string[], deleteData: boolean): Promise<void>;
  /** Moves a torrent to a zero-based queue position (drag and drop). */
  moveTo(id: string, index: number): Promise<void>;
  /** Moves a torrent one position up (`delta < 0`) or down the queue. */
  moveBy(id: string, delta: -1 | 1): Promise<void>;
  setMaxActive(maxActive: number): Promise<void>;
  setLimits(limits: { downLimit: number; upLimit: number }): Promise<void>;
  /** Folder new torrents are written to (Tauri: engine default). */
  setDownloadDir?(dir: string): Promise<void>;

  files(id: string): Promise<TorrentFile[]>;
  setFilePriority(id: string, fileId: number, priority: FilePriority): Promise<void>;
  trackers(id: string): Promise<TrackerInfo[]>;
  peers(id: string): Promise<PeerInfo[]>;

  checkForUpdates(): Promise<UpdateInfo>;
  openExternal(url: string): Promise<void>;

  /** Optional engine lifecycle hooks (mock provider only). */
  connect?(): void;
  disconnect?(): void;

  /** Mock-only switches, used by the settings dialog to demo both update states. */
  readonly mockHooks?: {
    setUpdateAvailable(available: boolean): void;
    isUpdateAvailable(): boolean;
  };
}
