import type {
  AddTorrentOptions,
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

  addFile(name?: string, options?: AddTorrentOptions): Promise<Torrent>;
  addMagnet(uri?: string, options?: AddTorrentOptions): Promise<Torrent>;
  /** Reads a `.torrent` file without adding it (name and file count). */
  previewFile?(name: string): Promise<TorrentPreview>;

  /** Native pickers; absent when the UI runs in a plain browser. */
  pickTorrentFile?(): Promise<string | null>;
  pickFolder?(): Promise<string | null>;
  /** First dropped path that is a directory (drag and drop of a folder). */
  firstDirectory?(paths: string[]): Promise<string | null>;

  /** Resolves when the folder can be used, rejects with a readable message. */
  validateDir?(dir: string): Promise<void>;
  /** System default download folder, shown when the setting is empty. */
  defaultDownloadDir?(): Promise<string>;
  /** Opens a folder (or reveals a file) in the file manager. */
  openFolder?(target: { id?: string; path?: string }): Promise<void>;
  /** Moves a stopped torrent to another folder; keeps the queue position. */
  setTorrentOutputDir?(id: string, dir: string): Promise<OutputDirChange>;

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

  /**
   * Windows handler registration: whether the app opens `magnet:` links and
   * `.torrent` files. Registering is per user and reversible; a failure is
   * reported in `error` instead of rejecting.
   */
  handlerStatus?(): Promise<HandlerStatus>;
  handlerRegister?(): Promise<HandlerStatus>;
  /** Puts the handlers that were there before the registration back. */
  handlerUnregister?(): Promise<HandlerStatus>;
  /** Opens the Windows "Default apps" page, the fallback when the switch does not stick. */
  openDefaultApps?(): Promise<void>;

  /** Text from the clipboard, for Ctrl+V of a magnet link. */
  readClipboard?(): Promise<string | null>;
  /**
   * Links the shell hands over (a second launch, a double click on a
   * `.torrent` file). Returns the unsubscribe function.
   */
  onLinkReceived?(handler: (payload: LinkPayload) => void): () => void;

  /**
   * "Power off when downloads finish": the settings and the countdown state.
   * The countdown itself lives in the engine (Rust); the UI only shows it.
   */
  powerStatus?(): Promise<PowerStatus>;
  setPowerSettings?(settings: PowerSettings): Promise<PowerStatus | void>;
  /** The "Cancel" button of the countdown banner. */
  cancelPowerOff?(): Promise<PowerStatus | void>;

  /** Optional engine lifecycle hooks (mock provider, and the event listener). */
  connect?(): void;
  disconnect?(): void;

  /** Mock-only switches, used by the settings dialog to demo both update states. */
  readonly mockHooks?: {
    setUpdateAvailable(available: boolean): void;
    isUpdateAvailable(): boolean;
    /** Demo hook: pretends every torrent reached 100 % (power-off banner). */
    finishAllDownloads?(): void;
    /** Demo hook: the text `readClipboard` answers with. */
    setClipboard?(text: string | null): void;
    /** Demo hook: delivers a `link-received` payload to the window. */
    emitLink?(payload: LinkPayload): void;
  };
}
