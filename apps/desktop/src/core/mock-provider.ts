// Mock engine adapter: in-memory torrents, fake progress, fake speeds.
// Replace with src/core/tauri-provider.ts once the Rust side is ready.

import {
  buildFiles,
  buildPeers,
  buildTrackers,
  createInitialTorrents,
  hexHash,
  MOCK_UPDATE_CHANGELOG,
  MOCK_UPDATE_URL,
  MOCK_UPDATE_VERSION,
  type MockTorrent,
} from './mock-data';
import type { TorrentProvider } from './provider';
import { normalizeTrackers } from './trackers';
import {
  PEER_LIMIT_DEFAULT,
  POWER_DELAY_DEFAULT,
  normalizePeerLimit,
  normalizePowerDelay,
  type AddTorrentOptions,
  type ConnectionChange,
  type ConnectionSettings,
  type FilePriority,
  type HandlerStatus,
  type LinkPayload,
  type OutputDirChange,
  type PeerInfo,
  type PowerAction,
  type PowerSettings,
  type PowerStatus,
  type SessionStats,
  type Torrent,
  type TorrentFile,
  type TorrentPreview,
  type TorrentStatus,
  type TrackerInfo,
  type UpdateInfo,
} from './types';
import { APP_VERSION } from './version';

const LABEL_CYCLE = ['Linux', 'Movies', 'Music', 'Docs', 'Software'];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Folders the mock pretends to be able to write to (`Z:\nope` is refused). */
const AVAILABLE_DRIVES = ['C', 'D', 'E'];

/** Where the mock keeps the handler registration between reloads. */
const HANDLER_STORAGE_KEY = 'brickman-torrent.handler.v1';

/** The registration the mock pretends the registry holds. */
interface MockHandlerState {
  registered: boolean;
  backupPresent: boolean;
}

const HANDLER_INITIAL: MockHandlerState = { registered: false, backupPresent: false };

function loadHandlerState(): MockHandlerState {
  try {
    const raw = localStorage.getItem(HANDLER_STORAGE_KEY);
    if (!raw) return { ...HANDLER_INITIAL };
    const parsed = JSON.parse(raw) as Partial<MockHandlerState>;
    return {
      registered: parsed.registered === true,
      // A registration without a backup could not be undone, so it is not a
      // state the mock ever reports.
      backupPresent: parsed.registered === true && parsed.backupPresent === true,
    };
  } catch (err) {
    console.warn('[brickman-torrent][mock] cannot read the handler state', err);
    return { ...HANDLER_INITIAL };
  }
}

function saveHandlerState(state: MockHandlerState): void {
  try {
    localStorage.setItem(HANDLER_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[brickman-torrent][mock] cannot store the handler state', err);
  }
}

/**
 * Joins a folder and a name the way the engine does. `outputDir` is empty in a
 * plain browser, so the mock has a placeholder root instead of a real path.
 */
function joinPath(folder: string, name: string): string {
  const separator = folder.includes('\\') ? '\\' : '/';
  const trimmed = folder.replace(/[\\/]+$/, '');
  return trimmed ? `${trimmed}${separator}${name}` : name;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

export class MockProvider implements TorrentProvider {
  readonly kind = 'mock' as const;

  readonly mockHooks = {
    setUpdateAvailable: (available: boolean): void => {
      this.updateAvailable = available;
    },
    isUpdateAvailable: (): boolean => this.updateAvailable,
    /** Pretends every torrent reached 100 % (the power settings demo). */
    finishAllDownloads: (): void => {
      this.finishAllDownloads();
    },
    /** What Ctrl+V finds on the clipboard (the smoke test drives it). */
    setClipboard: (text: string | null): void => {
      this.clipboardText = text;
    },
    /** Delivers a `link-received` payload, like the shell does. */
    emitLink: (payload: LinkPayload): void => {
      this.emitLink(payload);
    },
  };

  private torrents: MockTorrent[] = createInitialTorrents();
  private readonly fileMap = new Map<string, TorrentFile[]>();
  private maxActive = 1;
  private downLimit = 0;
  private upLimit = 0;
  // "Connections": the peer limit and the trackers are live, UPnP and uTP are
  // listener options (the mock keeps what it "started" with).
  private connections: ConnectionSettings = {
    upnpEnabled: true,
    utpEnabled: true,
    peerLimit: PEER_LIMIT_DEFAULT,
    extraTrackers: [],
  };
  /** `false` until the first settings push: that one is the startup config. */
  private listenerConfigured = false;
  private appliedUpnp = true;
  private appliedUtp = true;
  private updateAvailable = true;
  private tickHandle: number | null = null;
  private addCounter = 0;
  /** The `magnet:` / `.torrent` registration, in memory and in localStorage. */
  private handlerState: MockHandlerState = loadHandlerState();
  private clipboardText: string | null = null;
  private readonly linkHandlers = new Set<(payload: LinkPayload) => void>();
  // "Power off when downloads finish", mirrored from the Rust monitor.
  private powerAction: PowerAction = 'nothing';
  private powerDelaySecs = POWER_DELAY_DEFAULT;
  private powerDeadline: number | null = null;
  private powerCompleted = false;
  private readonly powerSeen = new Map<string, boolean>();

  constructor() {
    for (const torrent of this.torrents) {
      this.fileMap.set(torrent.id, buildFiles(torrent));
    }
    this.recomputeQueue();
    this.tick(false);
  }

  connect(): void {
    if (this.tickHandle !== null) return;
    this.tickHandle = window.setInterval(() => this.tick(), 1000);
  }

  disconnect(): void {
    if (this.tickHandle === null) return;
    window.clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  async list(): Promise<Torrent[]> {
    this.evaluatePower();
    return this.torrents.map((torrent) => this.snapshot(torrent));
  }

  async stats(): Promise<SessionStats> {
    const active = this.torrents.filter(
      (t) => (t.status === 'downloading' && !t.queued) || t.status === 'seeding',
    ).length;
    const peers = this.torrents.reduce((sum, t) => sum + t.peers, 0);
    const peersUtp = Math.floor(peers / 4);
    return {
      downSpeed: this.torrents.reduce((sum, t) => sum + t.downSpeed, 0),
      upSpeed: this.torrents.reduce((sum, t) => sum + t.upSpeed, 0),
      active,
      portOpen: true,
      port: 51413,
      upnpRequested: this.appliedUpnp,
      utpEnabled: this.appliedUtp,
      peerLimit: this.connections.peerLimit,
      peersTcp: peers - peersUtp,
      peersUtp,
      dhtNodes: 342,
      maxActive: this.maxActive,
      downLimit: this.downLimit,
      upLimit: this.upLimit,
    };
  }

  async addFile(name?: string, options?: AddTorrentOptions): Promise<Torrent> {
    this.addCounter += 1;
    const label = LABEL_CYCLE[this.addCounter % LABEL_CYCLE.length] ?? 'Docs';
    const file = name?.trim() ? baseName(name.trim()) : `new-torrent-${this.addCounter}`;
    const torrentName = file.replace(/\.torrent$/i, '');
    return this.insert(torrentName, label, 900 * 1024 * 1024, options);
  }

  async addMagnet(uri?: string, options?: AddTorrentOptions): Promise<Torrent> {
    this.addCounter += 1;
    const match = uri?.match(/[?&]dn=([^&]+)/);
    const decoded = match?.[1] ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
    const label = LABEL_CYCLE[this.addCounter % LABEL_CYCLE.length] ?? 'Other';
    return this.insert(
      decoded || `magnet-torrent-${this.addCounter}`,
      label,
      1.8 * 1024 * 1024 * 1024,
      options,
    );
  }

  /**
   * The browser has no file dialog: the mock answers with a fixed path so the
   * add flow (preview, folder, sub folder) is the same as in the desktop app.
   */
  async pickTorrentFile(): Promise<string | null> {
    return 'C:\\Users\\you\\Downloads\\ubuntu-24.04.3-desktop-amd64.iso.torrent';
  }

  /** A single-file torrent is an `.iso`; everything else is multi-file. */
  async previewFile(name: string): Promise<TorrentPreview> {
    const file = baseName(name);
    const single = /\.iso$/i.test(file);
    return {
      name: file.replace(/\.torrent$/i, ''),
      files: single ? 1 : 3,
    };
  }

  /** Mimics the Rust check: the same messages, no filesystem access. */
  async validateDir(dir: string): Promise<void> {
    const path = dir.trim();
    if (!path) throw new Error('download folder is empty');
    const drive = /^([A-Za-z]):[\\/]/.exec(path)?.[1]?.toUpperCase();
    if (drive && !AVAILABLE_DRIVES.includes(drive)) {
      throw new Error(`drive ${drive}: is not available`);
    }
  }

  async defaultDownloadDir(): Promise<string> {
    return 'C:\\Users\\you\\Downloads';
  }

  async openFolder(target: { id?: string; path?: string }): Promise<void> {
    const torrent = target.id
      ? this.torrents.find((item) => item.id === target.id)
      : undefined;
    console.info(
      '[brickman-torrent][mock] would open folder:',
      target.path ?? torrent?.savePath ?? '(unknown)',
    );
  }

  /** Refuses a running torrent, exactly like the core does. */
  async setTorrentOutputDir(id: string, dir: string): Promise<OutputDirChange> {
    const torrent = this.torrents.find((item) => item.id === id);
    if (!torrent) throw new Error(`torrent ${id} not found`);
    if (!['paused', 'stopped'].includes(torrent.status) && !torrent.queued) {
      throw new Error('stop the torrent before changing its download folder');
    }
    const folder = dir.trim();
    if (!folder) throw new Error('download folder is empty');
    await this.validateDir(folder);
    torrent.savePath = joinPath(folder, torrent.name.replace(/\.torrent$/i, ''));
    this.afterMutation();
    return { torrent: this.snapshot(torrent), movedFiles: 0, failedMoves: [] };
  }

  async start(ids: string[]): Promise<void> {
    for (const torrent of this.pick(ids)) {
      torrent.status = torrent.progress >= 1 ? 'seeding' : 'downloading';
    }
    // A lifted pause means downloads are running again: no countdown.
    this.powerDeadline = null;
    this.afterMutation();
  }

  async pause(ids: string[]): Promise<void> {
    for (const torrent of this.pick(ids)) {
      torrent.status = 'paused';
    }
    this.afterMutation();
  }

  async stop(ids: string[]): Promise<void> {
    for (const torrent of this.pick(ids)) {
      torrent.status = 'stopped';
    }
    this.afterMutation();
  }

  async remove(ids: string[], _deleteData: boolean): Promise<void> {
    const removeSet = new Set(ids);
    this.torrents = this.torrents.filter((torrent) => {
      if (!removeSet.has(torrent.id)) return true;
      this.fileMap.delete(torrent.id);
      return false;
    });
    this.reindexQueue();
    this.afterMutation();
  }

  /** Queue order is the array order: the first torrent downloads first. */
  async moveTo(id: string, index: number): Promise<void> {
    const from = this.torrents.findIndex((torrent) => torrent.id === id);
    if (from < 0) return;
    const to = clamp(Math.round(index), 0, this.torrents.length - 1);
    if (from === to) return;
    const [target] = this.torrents.splice(from, 1);
    if (target) this.torrents.splice(to, 0, target);
    this.reindexQueue();
    this.afterMutation();
  }

  async moveBy(id: string, delta: -1 | 1): Promise<void> {
    const from = this.torrents.findIndex((torrent) => torrent.id === id);
    if (from < 0) return;
    await this.moveTo(id, from + delta);
  }

  async setMaxActive(maxActive: number): Promise<void> {
    this.maxActive = clamp(Math.round(maxActive), 1, 50);
    this.afterMutation();
  }

  async setLimits(limits: { downLimit: number; upLimit: number }): Promise<void> {
    this.downLimit = Math.max(0, Math.round(limits.downLimit));
    this.upLimit = Math.max(0, Math.round(limits.upLimit));
    this.afterMutation();
  }

  /**
   * Same rule as the core: the peer limit and the trackers are used by the next
   * torrent, UPnP and uTP belong to the listener and are only reported as a
   * restart. The very first call is the startup config (`engine_init`).
   */
  async setConnectionSettings(settings: ConnectionSettings): Promise<ConnectionChange> {
    const peerLimit = normalizePeerLimit(settings.peerLimit);
    const extraTrackers = normalizeTrackers(settings.extraTrackers);
    const restartRequired =
      this.listenerConfigured &&
      (settings.upnpEnabled !== this.appliedUpnp || settings.utpEnabled !== this.appliedUtp);
    this.appliedUpnp = settings.upnpEnabled;
    this.appliedUtp = settings.utpEnabled;
    this.listenerConfigured = true;
    this.connections = {
      upnpEnabled: settings.upnpEnabled,
      utpEnabled: settings.utpEnabled,
      peerLimit,
      extraTrackers,
    };
    this.afterMutation();
    return { restartRequired, peerLimit, trackers: extraTrackers.length };
  }

  async files(id: string): Promise<TorrentFile[]> {
    const files = this.fileMap.get(id) ?? [];
    return files.map((file) => ({ ...file }));
  }

  async setFilePriority(id: string, fileId: number, priority: FilePriority): Promise<void> {
    const files = this.fileMap.get(id);
    if (!files) return;
    const file = files.find((item) => item.id === fileId);
    if (!file) return;
    file.priority = priority;
    if (priority === -1) {
      file.progress = 0;
      file.downloaded = 0;
    }
  }

  async trackers(id: string): Promise<TrackerInfo[]> {
    const torrent = this.torrents.find((item) => item.id === id);
    return torrent ? buildTrackers(torrent) : [];
  }

  async peers(id: string): Promise<PeerInfo[]> {
    const torrent = this.torrents.find((item) => item.id === id);
    return torrent ? buildPeers(torrent) : [];
  }

  /** Mock update endpoint: ~800 ms of latency, answer controlled by settings. */
  async checkForUpdates(): Promise<UpdateInfo> {
    await sleep(800);
    return {
      available: this.updateAvailable,
      currentVersion: APP_VERSION,
      version: this.updateAvailable ? MOCK_UPDATE_VERSION : null,
      changelog: this.updateAvailable ? [...MOCK_UPDATE_CHANGELOG] : [],
      url: this.updateAvailable ? MOCK_UPDATE_URL : null,
      checkedAt: Date.now(),
    };
  }

  async openExternal(url: string): Promise<void> {
    console.info('[brickman-torrent][mock] would open external URL:', url);
  }

  // -------------------------------------------------------------- links

  /**
   * The registry the mock pretends to write: two booleans in localStorage.
   * Registering also backs up "the previous handlers", which is what makes
   * "Remove registration" possible; unregistering drops both again.
   */
  async handlerStatus(): Promise<HandlerStatus> {
    return {
      registered: this.handlerState.registered,
      backupPresent: this.handlerState.backupPresent,
    };
  }

  async handlerRegister(): Promise<HandlerStatus> {
    await sleep(120);
    this.handlerState = { registered: true, backupPresent: true };
    saveHandlerState(this.handlerState);
    console.info('[brickman-torrent][mock] registered as the magnet/.torrent handler');
    return this.handlerStatus();
  }

  async handlerUnregister(): Promise<HandlerStatus> {
    await sleep(120);
    this.handlerState = { ...HANDLER_INITIAL };
    saveHandlerState(this.handlerState);
    console.info('[brickman-torrent][mock] handler registration removed');
    return this.handlerStatus();
  }

  async openDefaultApps(): Promise<void> {
    console.info('[brickman-torrent][mock] would open ms-settings:defaultapps');
  }

  /** The browser cannot read the real clipboard: the test sets the text. */
  async readClipboard(): Promise<string | null> {
    const text = this.clipboardText?.trim();
    return text ? text : null;
  }

  onLinkReceived(handler: (payload: LinkPayload) => void): () => void {
    this.linkHandlers.add(handler);
    return () => {
      this.linkHandlers.delete(handler);
    };
  }

  private emitLink(payload: LinkPayload): void {
    for (const handler of this.linkHandlers) handler(payload);
  }

  // ------------------------------------------------- power after downloads

  async setPowerSettings(settings: PowerSettings): Promise<PowerStatus> {
    this.powerAction = settings.action;
    this.powerDelaySecs = normalizePowerDelay(settings.delaySecs);
    // A changed setting drops the running countdown, like the Rust side does.
    this.powerDeadline = null;
    return this.powerStatus();
  }

  async powerStatus(): Promise<PowerStatus> {
    this.evaluatePower();
    return {
      action: this.powerAction,
      delaySecs: this.powerDelaySecs,
      pending: this.powerDeadline !== null,
      secondsLeft: this.powerSecondsLeft(),
      // The mock never runs anything: it always behaves like a dry run.
      dryRun: true,
    };
  }

  async cancelPowerOff(): Promise<PowerStatus> {
    this.powerDeadline = null;
    this.powerCompleted = false;
    console.info('[brickman-torrent][mock] power countdown cancelled');
    return this.powerStatus();
  }

  // ---------------------------------------------------------------- internals

  private powerSecondsLeft(): number {
    if (this.powerDeadline === null) return 0;
    return Math.max(0, Math.ceil((this.powerDeadline - Date.now()) / 1000));
  }

  /**
   * Same rule as the Rust monitor: every torrent has to be at 100 % and at
   * least one of them has to have finished while this page was open. With no
   * such transition the countdown never starts, so a restored list stays quiet.
   */
  private evaluatePower(): void {
    const allComplete = this.torrents.length > 0 && this.torrents.every((t) => t.progress >= 1);
    for (const torrent of this.torrents) {
      const complete = torrent.progress >= 1;
      const previous = this.powerSeen.get(torrent.id);
      if (previous === false && complete) this.powerCompleted = true;
      this.powerSeen.set(torrent.id, complete);
    }
    for (const id of [...this.powerSeen.keys()]) {
      if (!this.torrents.some((torrent) => torrent.id === id)) this.powerSeen.delete(id);
    }

    const condition = allComplete && this.powerCompleted && this.powerAction !== 'nothing';
    if (!condition) {
      this.powerDeadline = null;
      return;
    }
    if (this.powerDeadline === null) {
      this.powerDeadline = Date.now() + this.powerDelaySecs * 1000;
      console.info(
        '[brickman-torrent][mock] power countdown started:',
        this.powerAction,
        `${this.powerDelaySecs} s`,
      );
      return;
    }
    if (Date.now() >= this.powerDeadline) {
      this.powerDeadline = null;
      this.powerCompleted = false;
      console.info(
        '[brickman-torrent][mock] DRYRUN: would run the power action',
        this.powerAction,
      );
    }
  }

  /** Marks every torrent as downloaded, as if the downloads just finished. */
  private finishAllDownloads(): void {
    for (const torrent of this.torrents) {
      torrent.progress = 1;
      torrent.downloaded = torrent.size;
      torrent.status = 'seeding';
      torrent.downSpeed = 0;
      torrent.etaSec = null;
      torrent.pieces.have = torrent.pieces.total;
      for (const file of this.fileMap.get(torrent.id) ?? []) {
        file.progress = 1;
        file.downloaded = file.size;
      }
    }
    this.powerCompleted = true;
    this.powerDeadline = null;
    this.recomputeQueue();
  }

  private pick(ids: string[]): MockTorrent[] {
    const wanted = new Set(ids);
    return this.torrents.filter((torrent) => wanted.has(torrent.id));
  }

  private snapshot(torrent: MockTorrent): Torrent {
    // The queue is the array order; the position shown as "#" is derived from
    // it, exactly like the Rust core derives it from `State::order`.
    const ordinal = this.torrents.indexOf(torrent) + 1;
    return { ...torrent, ordinal, priority: ordinal, pieces: { ...torrent.pieces } };
  }

  private insert(
    name: string,
    label: string,
    size: number,
    options?: AddTorrentOptions,
  ): Torrent {
    const outputDir = options?.outputDir?.trim() ?? '';
    const subfolder = options?.createSubfolder ?? true;
    const folder = outputDir || `D:\\Torrents\\${label}`;
    // The add dialog's "start paused" is a user pause, like in the core.
    const status: TorrentStatus = options?.startPaused ? 'paused' : 'downloading';
    const torrent: MockTorrent = {
      id: `mock-new-${Date.now().toString(36)}-${this.addCounter}`,
      ordinal: this.torrents.length + 1,
      name,
      size: Math.round(size),
      status,
      progress: 0,
      downSpeed: 0,
      upSpeed: 0,
      seeds: 0,
      seedsTotal: 24,
      peers: 0,
      peersTotal: 4,
      etaSec: null,
      priority: this.torrents.length + 1,
      label,
      queued: false,
      addedAt: Date.now(),
      downloaded: 0,
      uploaded: 0,
      ratio: 0,
      savePath: subfolder ? joinPath(folder, name.replace(/\.torrent$/i, '')) : folder,
      hash: hexHash(`${name}:${Date.now()}`),
      pieces: { have: 0, total: Math.max(64, Math.round(size / (1024 * 1024))) },
      connections: 0,
      comment: '',
      baseDown: 2.5 * 1024 * 1024,
      phase: 1,
      upFactor: 0.05,
    };
    this.torrents.push(torrent);
    this.fileMap.set(torrent.id, buildFiles(torrent));
    // A new download is a reason to stop a running "power off" countdown.
    this.powerDeadline = null;
    this.afterMutation();
    return this.snapshot(torrent);
  }

  private afterMutation(): void {
    this.recomputeQueue();
    this.tick(false);
  }

  private reindexQueue(): void {
    this.torrents.forEach((torrent, index) => {
      torrent.ordinal = index + 1;
      torrent.priority = index + 1;
    });
  }

  private recomputeQueue(): void {
    // Candidates keep the queue order of the array.
    const candidates = this.torrents.filter((torrent) => torrent.status === 'downloading');
    candidates.forEach((torrent, index) => {
      torrent.queued = index >= this.maxActive;
    });
    for (const torrent of this.torrents) {
      if (torrent.status !== 'downloading') torrent.queued = false;
    }
  }

  private tick(advance = true): void {
    const now = Date.now();
    this.recomputeQueue();
    const activeCount = Math.max(
      1,
      this.torrents.filter((t) => t.status === 'downloading' && !t.queued).length,
    );

    for (const torrent of this.torrents) {
      const wave = 0.72 + 0.28 * Math.sin((now / 6500) * torrent.phase + torrent.baseDown);
      const status: TorrentStatus = torrent.status;

      if (status === 'downloading' && !torrent.queued) {
        const perTorrentCap =
          this.downLimit > 0 ? (this.downLimit * 1024) / activeCount : Number.POSITIVE_INFINITY;
        torrent.downSpeed = Math.round(Math.min(torrent.baseDown, perTorrentCap) * wave);
        if (advance && torrent.downSpeed > 0) {
          torrent.progress = Math.min(1, torrent.progress + (torrent.downSpeed * 3) / torrent.size);
          torrent.downloaded = Math.min(torrent.size, Math.round(torrent.size * torrent.progress));
        }
        torrent.etaSec =
          torrent.downSpeed > 0
            ? Math.round((torrent.size - torrent.size * torrent.progress) / torrent.downSpeed)
            : null;
        torrent.upSpeed = Math.round(torrent.downSpeed * 0.14 * (0.6 + torrent.upFactor));
        if (advance) torrent.uploaded += torrent.upSpeed;
        if (torrent.progress >= 1) {
          torrent.status = 'seeding';
          torrent.progress = 1;
          torrent.downloaded = torrent.size;
          torrent.downSpeed = 0;
          torrent.etaSec = null;
        }
      } else if (status === 'seeding') {
        const cap = this.upLimit > 0 ? this.upLimit * 1024 : Number.POSITIVE_INFINITY;
        torrent.progress = 1;
        torrent.downloaded = torrent.size;
        torrent.downSpeed = 0;
        torrent.etaSec = null;
        torrent.upSpeed = Math.round(Math.min(340 * 1024 * torrent.upFactor, cap) * wave);
        if (advance) torrent.uploaded += torrent.upSpeed;
      } else {
        torrent.downSpeed = 0;
        torrent.upSpeed = 0;
        torrent.etaSec = null;
      }

      torrent.ratio = torrent.downloaded > 0 ? torrent.uploaded / torrent.downloaded : 0;
      torrent.pieces.have = Math.round(torrent.pieces.total * torrent.progress);
      torrent.connections = torrent.peers + 3;
      this.syncFiles(torrent);
    }
  }

  private syncFiles(torrent: MockTorrent): void {
    const files = this.fileMap.get(torrent.id);
    if (!files || files.length === 0) return;
    const slice = 1 / files.length;
    files.forEach((file, index) => {
      if (torrent.progress >= 1) {
        file.progress = 1;
      } else if (file.priority === -1) {
        file.progress = 0;
      } else {
        file.progress = clamp((torrent.progress - index * slice) / slice, 0, 1);
      }
      file.downloaded = Math.round(file.size * file.progress);
    });
  }
}

export function createMockProvider(): TorrentProvider {
  return new MockProvider();
}
