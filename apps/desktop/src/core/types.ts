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

/** What the app does when no download is left. */
export type PowerAction = 'nothing' | 'sleep' | 'hibernate' | 'shutdown' | 'force-shutdown';

/** The `onDownloadsComplete` settings block. */
export interface PowerSettings {
  action: PowerAction;
  /** Seconds between "all downloads finished" and the action. */
  delaySecs: number;
}

/** State of the countdown, polled once a second by the UI. */
export interface PowerStatus {
  action: PowerAction;
  delaySecs: number;
  pending: boolean;
  secondsLeft: number;
  /** The command is only logged (`BRICKMAN_POWER_DRYRUN=1`). */
  dryRun: boolean;
}

export const POWER_ACTIONS: readonly PowerAction[] = [
  'nothing',
  'sleep',
  'hibernate',
  'shutdown',
  'force-shutdown',
];

export const POWER_DELAY_DEFAULT = 60;
export const POWER_DELAY_MIN = 5;
export const POWER_DELAY_MAX = 600;

/** Anything stored by an older version falls back to "do nothing". */
export function normalizePowerAction(value: unknown): PowerAction {
  return typeof value === 'string' && (POWER_ACTIONS as readonly string[]).includes(value)
    ? (value as PowerAction)
    : 'nothing';
}

/** Clamps the delay to the range the settings dialog offers. */
export function normalizePowerDelay(value: unknown): number {
  const secs = Math.round(Number(value));
  if (!Number.isFinite(secs)) return POWER_DELAY_DEFAULT;
  return Math.min(POWER_DELAY_MAX, Math.max(POWER_DELAY_MIN, secs));
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
  /** Where the add dialog puts the torrent when nothing else is chosen (default on). */
  createSubfolderDefault: boolean;
  /** Shut down / sleep once every download has finished (default: nothing). */
  onDownloadsComplete: PowerAction;
  /** Countdown before the action above, seconds (5–600, default 60). */
  powerDelaySecs: number;
  /**
   * Folders used recently for adding, newest first (at most
   * {@link RECENT_FOLDERS_LIMIT}). The first entry is also "the folder last
   * used", so it survives a restart with the rest of the settings.
   */
  recentFolders: string[];
}

/** Per-add choices from the add dialog. */
export interface AddTorrentOptions {
  /** Folder to download into; empty/undefined = the folder from the settings. */
  outputDir?: string;
  /** Write the files into a sub folder named after the torrent. */
  createSubfolder?: boolean;
  /** Add the torrent paused instead of queueing it. */
  startPaused?: boolean;
}

/** What a `.torrent` file contains, without adding it. */
export interface TorrentPreview {
  name: string;
  files: number;
}

/** Result of moving a torrent to another folder. */
export interface OutputDirChange {
  torrent: Torrent;
  movedFiles: number;
  /** Relative paths that could not be moved and will be downloaded again. */
  failedMoves: string[];
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
  createSubfolderDefault: true,
  onDownloadsComplete: 'nothing',
  powerDelaySecs: POWER_DELAY_DEFAULT,
  recentFolders: [],
};

/** How many folders the "recent folders" list keeps. */
export const RECENT_FOLDERS_LIMIT = 5;

/**
 * Puts `dir` at the top of a recent-folders list: duplicates collapse
 * (case-insensitively, пути Windows), the list is capped at
 * {@link RECENT_FOLDERS_LIMIT}.
 */
export function withRecentFolder(recent: readonly string[], dir: string): string[] {
  const wanted = dir.trim();
  if (!wanted) return [...recent];
  const key = wanted.toLocaleLowerCase();
  return [wanted, ...recent.filter((item) => item.trim().toLocaleLowerCase() !== key)]
    .slice(0, RECENT_FOLDERS_LIMIT);
}
