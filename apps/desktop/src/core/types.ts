// Shared UI/domain types. The shape mirrors what a real engine adapter is
// expected to return over Tauri commands (see README "Integration contract").

export type TorrentStatus =
  | 'downloading'
  | 'seeding'
  | 'paused'
  | 'queued'
  | 'checking'
  | 'stopped'
  | 'completed'
  | 'error';

// `-1` = don't download, `1` = download. The engine selects files by
// inclusion, so there are no intermediate priority levels.
export type FilePriority = -1 | 1;

export interface Torrent {
  id: string;
  /** 1-based queue position shown in the "#" column. */
  ordinal: number;
  name: string;
  size: number;
  status: TorrentStatus;
  /** 0..1 */
  progress: number;
  downSpeed: number;
  upSpeed: number;
  /** Connected seeds / seeds in swarm. */
  seeds: number;
  seedsTotal: number;
  peers: number;
  peersTotal: number;
  etaSec: number | null;
  /** Queue position, `1` = first; derived from the order, not stored. */
  priority: number;
  label: string;
  /** True when the torrent is waiting because of the max-active limit. */
  queued: boolean;
  addedAt: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  savePath: string;
  hash: string;
  pieces: { have: number; total: number };
  connections: number;
  comment: string;
}

export interface TorrentFile {
  id: number;
  path: string;
  size: number;
  downloaded: number;
  progress: number;
  priority: FilePriority;
}

export type TrackerStatus = 'working' | 'updating' | 'error' | 'idle';

export interface TrackerInfo {
  url: string;
  tier: number;
  status: TrackerStatus;
  peers: number;
  seeds: number;
  nextAnnounceSec: number;
  message: string;
}

export interface PeerInfo {
  address: string;
  client: string;
  down: number;
  up: number;
  progress: number;
  flags: string;
}

export interface SessionStats {
  downSpeed: number;
  upSpeed: number;
  active: number;
  portOpen: boolean;
  port: number;
  dhtNodes: number;
  maxActive: number;
  downLimit: number;
  upLimit: number;
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  version: string | null;
  /** Translation keys or plain prose: t() falls back to the string itself. */
  changelog: string[];
  url: string | null;
  checkedAt: number;
}

export interface AppSettings {
  theme: 'light' | 'dark';
  locale: 'en' | 'ru';
  checkUpdatesOnStartup: boolean;
  maxActive: number;
  downLimit: number; // kB/s, 0 = unlimited
  upLimit: number; // kB/s, 0 = unlimited
  /** Download folder; empty string = the system default (Downloads). */
  downloadDir: string;
}

/** A torrent is displayed as "Queued" while it waits for a free active slot. */
export function effectiveStatus(torrent: Torrent): TorrentStatus {
  return torrent.queued ? 'queued' : torrent.status;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  locale: 'en',
  checkUpdatesOnStartup: true,
  /** One download at a time: the queue decides who gets the bandwidth. */
  maxActive: 1,
  downLimit: 0,
  upLimit: 0,
  downloadDir: '',
};
