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
import type {
  FilePriority,
  PeerInfo,
  SessionStats,
  Torrent,
  TorrentFile,
  TorrentStatus,
  TrackerInfo,
  UpdateInfo,
} from './types';
import { APP_VERSION } from './version';

const LABEL_CYCLE = ['Linux', 'Movies', 'Music', 'Docs', 'Software'];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export class MockProvider implements TorrentProvider {
  readonly kind = 'mock' as const;

  readonly mockHooks = {
    setUpdateAvailable: (available: boolean): void => {
      this.updateAvailable = available;
    },
    isUpdateAvailable: (): boolean => this.updateAvailable,
  };

  private torrents: MockTorrent[] = createInitialTorrents();
  private readonly fileMap = new Map<string, TorrentFile[]>();
  private maxActive = 4;
  private downLimit = 0;
  private upLimit = 0;
  private updateAvailable = true;
  private tickHandle: number | null = null;
  private addCounter = 0;

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
    return this.torrents.map((torrent) => this.snapshot(torrent));
  }

  async stats(): Promise<SessionStats> {
    const active = this.torrents.filter(
      (t) => (t.status === 'downloading' && !t.queued) || t.status === 'seeding',
    ).length;
    return {
      downSpeed: this.torrents.reduce((sum, t) => sum + t.downSpeed, 0),
      upSpeed: this.torrents.reduce((sum, t) => sum + t.upSpeed, 0),
      active,
      portOpen: true,
      port: 51413,
      dhtNodes: 342,
      maxActive: this.maxActive,
      downLimit: this.downLimit,
      upLimit: this.upLimit,
    };
  }

  async addFile(name?: string): Promise<Torrent> {
    this.addCounter += 1;
    const label = LABEL_CYCLE[this.addCounter % LABEL_CYCLE.length] ?? 'Docs';
    const torrentName = name?.trim() || `new-torrent-${this.addCounter}.torrent`;
    return this.insert(torrentName, label, 900 * 1024 * 1024);
  }

  async addMagnet(uri?: string): Promise<Torrent> {
    this.addCounter += 1;
    const match = uri?.match(/[?&]dn=([^&]+)/);
    const decoded = match?.[1] ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
    const label = LABEL_CYCLE[this.addCounter % LABEL_CYCLE.length] ?? 'Other';
    return this.insert(decoded || `magnet-torrent-${this.addCounter}`, label, 1.8 * 1024 * 1024 * 1024);
  }

  async start(ids: string[]): Promise<void> {
    for (const torrent of this.pick(ids)) {
      torrent.status = torrent.progress >= 1 ? 'seeding' : 'downloading';
    }
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
    this.normalizePriorities();
    this.afterMutation();
  }

  async setPriority(id: string, priority: number): Promise<void> {
    const target = this.torrents.find((torrent) => torrent.id === id);
    if (!target) return;
    const ordered = this.torrents
      .filter((torrent) => torrent.id !== id)
      .sort((a, b) => a.priority - b.priority);
    const index = clamp(Math.round(priority) - 1, 0, ordered.length);
    ordered.splice(index, 0, target);
    ordered.forEach((torrent, i) => {
      torrent.priority = i + 1;
    });
    this.afterMutation();
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

  // ---------------------------------------------------------------- internals

  private pick(ids: string[]): MockTorrent[] {
    const wanted = new Set(ids);
    return this.torrents.filter((torrent) => wanted.has(torrent.id));
  }

  private snapshot(torrent: MockTorrent): Torrent {
    return { ...torrent, pieces: { ...torrent.pieces } };
  }

  private insert(name: string, label: string, size: number): Torrent {
    const maxPriority = this.torrents.reduce((max, t) => Math.max(max, t.priority), 0);
    const torrent: MockTorrent = {
      id: `mock-new-${Date.now().toString(36)}-${this.addCounter}`,
      ordinal: this.torrents.length + 1,
      name,
      size: Math.round(size),
      status: 'downloading',
      progress: 0,
      downSpeed: 0,
      upSpeed: 0,
      seeds: 0,
      seedsTotal: 24,
      peers: 0,
      peersTotal: 4,
      etaSec: null,
      priority: maxPriority + 1,
      label,
      queued: false,
      addedAt: Date.now(),
      downloaded: 0,
      uploaded: 0,
      ratio: 0,
      savePath: `D:\\Torrents\\${label}`,
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
    this.afterMutation();
    return this.snapshot(torrent);
  }

  private afterMutation(): void {
    this.recomputeQueue();
    this.tick(false);
  }

  private normalizePriorities(): void {
    [...this.torrents]
      .sort((a, b) => a.priority - b.priority)
      .forEach((torrent, index) => {
        torrent.priority = index + 1;
      });
    this.torrents.forEach((torrent, index) => {
      torrent.ordinal = index + 1;
    });
  }

  private recomputeQueue(): void {
    const candidates = this.torrents
      .filter((torrent) => torrent.status === 'downloading')
      .sort((a, b) => a.priority - b.priority);
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
