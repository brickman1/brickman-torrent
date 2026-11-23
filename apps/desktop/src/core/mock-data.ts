// Deterministic mock data for the UI prototype. No network, no engine.
// Everything here is replaced by the Tauri provider once the engine is wired.
//
// All sample torrents are legal / public content: Linux distributions, Blender
// Foundation open movies (CC BY), public datasets, open-source software and a
// Creative Commons music sampler. No commercial releases, no release groups.

import type {
  FilePriority,
  PeerInfo,
  Torrent,
  TorrentFile,
  TorrentStatus,
  TrackerInfo,
  TrackerStatus,
} from './types';

export interface MockTorrent extends Torrent {
  /** Base download rate used by the ticker, bytes/s. */
  baseDown: number;
  /** Speed fluctuation phase. */
  phase: number;
  /** Upload ratio relative to the download rate. */
  upFactor: number;
}

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const DAY = 86_400_000;

export const MOCK_UPDATE_VERSION = '0.4.1';
export const MOCK_UPDATE_URL = 'https://example.com/brickman-torrent/releases/0.4.1';
export const MOCK_UPDATE_CHANGELOG = [
  'update.changelog.limits',
  'update.changelog.resume',
  'update.changelog.port',
];

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hexHash(value: string): string {
  let state = hashString(value);
  let out = '';
  for (let i = 0; i < 40; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += (state % 16).toString(16);
  }
  return out;
}

interface TorrentSeed {
  name: string;
  size: number;
  status: TorrentStatus;
  progress: number;
  priority: number;
  label: string;
  baseDown: number;
  upFactor: number;
  seeds: number;
  seedsTotal: number;
  peers: number;
  peersTotal: number;
  ageDays: number;
  comment: string;
}

const SEEDS: TorrentSeed[] = [
  {
    name: 'ubuntu-24.04.3-live-server-amd64.iso',
    size: 2.9 * GB,
    status: 'downloading',
    progress: 0.623,
    priority: 1,
    label: 'Linux',
    baseDown: 4.2 * MB,
    upFactor: 0.06,
    seeds: 18,
    seedsTotal: 214,
    peers: 6,
    peersTotal: 48,
    ageDays: 2,
    comment: 'Ubuntu 24.04.3 LTS live-server image.',
  },
  {
    name: 'debian-13.0.0-amd64-netinst.iso',
    size: 690 * MB,
    status: 'downloading',
    progress: 0.871,
    priority: 2,
    label: 'Linux',
    baseDown: 3.1 * MB,
    upFactor: 0.04,
    seeds: 9,
    seedsTotal: 76,
    peers: 4,
    peersTotal: 21,
    ageDays: 4,
    comment: 'Debian 13 netinst installer.',
  },
  {
    name: 'Sintel (2010) 1080p.mp4',
    size: 590 * MB,
    status: 'downloading',
    progress: 0.412,
    priority: 3,
    label: 'Movies',
    baseDown: 1.8 * MB,
    upFactor: 0.11,
    seeds: 41,
    seedsTotal: 612,
    peers: 14,
    peersTotal: 133,
    ageDays: 6,
    comment: 'Sintel (2010), Blender Foundation, CC BY 3.0.',
  },
  {
    name: 'Fedora-Workstation-Live-42-1.1.x86_64.iso',
    size: 2.6 * GB,
    status: 'downloading',
    progress: 0.341,
    priority: 4,
    label: 'Linux',
    baseDown: 4.6 * MB,
    upFactor: 0.05,
    seeds: 22,
    seedsTotal: 187,
    peers: 8,
    peersTotal: 39,
    ageDays: 1,
    comment: 'Fedora Workstation 42 live image.',
  },
  {
    name: 'archlinux-2026.11.01-x86_64.iso',
    size: 1.3 * GB,
    status: 'downloading',
    progress: 0.182,
    priority: 5,
    label: 'Linux',
    baseDown: 2.1 * MB,
    upFactor: 0.05,
    seeds: 12,
    seedsTotal: 187,
    peers: 5,
    peersTotal: 39,
    ageDays: 1,
    comment: 'Arch Linux monthly snapshot.',
  },
  {
    name: 'openSUSE-Tumbleweed-DVD-x86_64-Build20261118.iso',
    size: 4.6 * GB,
    status: 'downloading',
    progress: 0.013,
    priority: 6,
    label: 'Linux',
    baseDown: 5 * MB,
    upFactor: 0.04,
    seeds: 15,
    seedsTotal: 132,
    peers: 3,
    peersTotal: 27,
    ageDays: 1,
    comment: 'openSUSE Tumbleweed DVD snapshot.',
  },
  {
    name: 'ubuntu-24.04.3-desktop-amd64.iso',
    size: 6.1 * GB,
    status: 'seeding',
    progress: 1,
    priority: 7,
    label: 'Linux',
    baseDown: 0,
    upFactor: 1.4,
    seeds: 0,
    seedsTotal: 240,
    peers: 11,
    peersTotal: 63,
    ageDays: 32,
    comment: 'Ubuntu 24.04.3 LTS desktop image.',
  },
  {
    name: 'Big Buck Bunny (2008) 1080p.mp4',
    size: 355 * MB,
    status: 'seeding',
    progress: 1,
    priority: 8,
    label: 'Movies',
    baseDown: 0,
    upFactor: 1.1,
    seeds: 0,
    seedsTotal: 180,
    peers: 9,
    peersTotal: 54,
    ageDays: 19,
    comment: 'Big Buck Bunny (2008), Blender Foundation, CC BY 3.0.',
  },
  {
    name: 'LibreOffice-25.8.4-x86_64.AppImage',
    size: 380 * MB,
    status: 'completed',
    progress: 1,
    priority: 9,
    label: 'Software',
    baseDown: 0,
    upFactor: 0.4,
    seeds: 0,
    seedsTotal: 44,
    peers: 2,
    peersTotal: 9,
    ageDays: 18,
    comment: 'LibreOffice AppImage build.',
  },
  {
    name: 'linuxmint-22.2-cinnamon-64bit.iso',
    size: 3 * GB,
    status: 'paused',
    progress: 0.552,
    priority: 10,
    label: 'Linux',
    baseDown: 1.9 * MB,
    upFactor: 0.03,
    seeds: 6,
    seedsTotal: 141,
    peers: 2,
    peersTotal: 30,
    ageDays: 15,
    comment: 'Linux Mint 22.2 Cinnamon image.',
  },
  {
    name: 'ruwiki-20261120-pages-articles-multistream.xml.bz2',
    size: 6.4 * GB,
    status: 'paused',
    progress: 0.442,
    priority: 11,
    label: 'Docs',
    baseDown: 1.2 * MB,
    upFactor: 0.12,
    seeds: 14,
    seedsTotal: 96,
    peers: 5,
    peersTotal: 19,
    ageDays: 27,
    comment: 'Russian Wikipedia dump, CC BY-SA 4.0.',
  },
  {
    name: 'krita-5.2.11-x86_64.AppImage',
    size: 210 * MB,
    status: 'paused',
    progress: 0.781,
    priority: 12,
    label: 'Software',
    baseDown: 700 * KB,
    upFactor: 0.08,
    seeds: 4,
    seedsTotal: 38,
    peers: 2,
    peersTotal: 11,
    ageDays: 9,
    comment: 'Krita digital painting AppImage.',
  },
  {
    name: 'Free Music Archive - Creative Commons Sampler (FLAC)',
    size: 420 * MB,
    status: 'seeding',
    progress: 1,
    priority: 13,
    label: 'Music',
    baseDown: 0,
    upFactor: 1.6,
    seeds: 0,
    seedsTotal: 58,
    peers: 7,
    peersTotal: 21,
    ageDays: 21,
    comment: 'Creative Commons music sampler (CC BY / CC BY-SA tracks).',
  },
  {
    name: 'Tears of Steel (2012) 4K.mp4',
    size: 1.2 * GB,
    status: 'stopped',
    progress: 0.118,
    priority: 14,
    label: 'Movies',
    baseDown: 2.6 * MB,
    upFactor: 0.02,
    seeds: 5,
    seedsTotal: 51,
    peers: 1,
    peersTotal: 14,
    ageDays: 7,
    comment: 'Tears of Steel (2012), Blender Foundation, CC BY 3.0.',
  },
  {
    name: 'nasa-noaa-viirs-nightlights-2026.zip',
    size: 2.4 * GB,
    status: 'checking',
    progress: 0.307,
    priority: 15,
    label: 'Docs',
    baseDown: 2.4 * MB,
    upFactor: 0.01,
    seeds: 3,
    seedsTotal: 27,
    peers: 2,
    peersTotal: 8,
    ageDays: 5,
    comment: 'NASA/NOAA open data: VIIRS night-time lights mosaic (public domain).',
  },
];

function buildTorrent(seed: TorrentSeed, index: number): MockTorrent {
  const hash = hashString(seed.name);
  const downloaded = Math.round(seed.size * seed.progress);
  const uploaded = Math.round(downloaded * seed.upFactor * 2.4);
  const pieceTotal = Math.max(64, Math.min(20000, Math.round(seed.size / MB)));
  const etaSec =
    seed.status === 'downloading' && seed.baseDown > 0
      ? Math.round((seed.size - downloaded) / seed.baseDown)
      : null;

  return {
    id: `mock-${hash.toString(16)}`,
    ordinal: index + 1,
    name: seed.name,
    size: Math.round(seed.size),
    status: seed.status,
    progress: seed.progress,
    downSpeed: 0,
    upSpeed: 0,
    seeds: seed.seeds,
    seedsTotal: seed.seedsTotal,
    peers: seed.peers,
    peersTotal: seed.peersTotal,
    etaSec,
    priority: seed.priority,
    label: seed.label,
    queued: false,
    addedAt: Date.now() - seed.ageDays * DAY - (hash % 3600) * 1000,
    downloaded,
    uploaded,
    ratio: downloaded > 0 ? uploaded / downloaded : 0,
    savePath: `D:\\Torrents\\${seed.label}`,
    hash: hexHash(seed.name),
    pieces: { have: Math.round(pieceTotal * seed.progress), total: pieceTotal },
    connections: seed.peers + 3,
    comment: seed.comment,
    baseDown: seed.baseDown,
    phase: 0.6 + (hash % 100) / 140,
    upFactor: seed.upFactor,
  };
}

export function createInitialTorrents(): MockTorrent[] {
  return SEEDS.map(buildTorrent);
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

interface FileBlueprint {
  path: string;
  weight: number;
  priority?: FilePriority;
}

const TRACK_NAMES = [
  'Opening',
  'Morning Light',
  'Paper Planes',
  'Slow Motion',
  'City Walk',
  'Blue Hour',
  'Quiet Street',
  'Open Sky',
  'Afterglow',
  'Long Drive',
  'Night Bus',
  'Credits',
];

function blueprint(torrent: Torrent): FileBlueprint[] {
  const base = stem(torrent.name);
  switch (torrent.label) {
    case 'Movies':
      return [
        { path: torrent.name, weight: 1000 },
        { path: `${base}.en.srt`, weight: 0.2 },
        { path: 'LICENSE.txt', weight: 0.05 },
      ];
    case 'Music':
      return TRACK_NAMES.map((title, index) => ({
        path: `${base}/${String(index + 1).padStart(2, '0')} - ${title}.flac`,
        weight: 10,
      }));
    case 'Linux':
      return [
        { path: `${base}/${base}.iso`, weight: 1000 },
        { path: `${base}/SHA256SUMS`, weight: 0.01 },
        { path: `${base}/README.txt`, weight: 0.03 },
      ];
    case 'Software':
      return [
        { path: torrent.name, weight: 1000 },
        { path: 'LICENSE.txt', weight: 0.05 },
      ];
    case 'Docs':
      return [
        { path: torrent.name, weight: 1000 },
        { path: 'SHA256SUMS', weight: 0.01 },
        { path: 'README.txt', weight: 0.03 },
      ];
    default:
      return [
        { path: torrent.name, weight: 1000 },
        { path: 'README.md', weight: 0.03 },
      ];
  }
}

export function buildFiles(torrent: Torrent): TorrentFile[] {
  const plan = blueprint(torrent);
  const totalWeight = plan.reduce((sum, item) => sum + item.weight, 0);
  const files: TorrentFile[] = [];
  let allocated = 0;

  plan.forEach((item, index) => {
    const isLast = index === plan.length - 1;
    const size = isLast
      ? Math.max(1, torrent.size - allocated)
      : Math.max(1, Math.round((torrent.size * item.weight) / totalWeight));
    allocated += size;

    const slice = 1 / plan.length;
    const raw = (torrent.progress - index * slice) / slice;
    const priority: FilePriority = item.priority ?? 1;
    const progress =
      torrent.progress >= 1 ? 1 : priority === -1 ? 0 : Math.min(1, Math.max(0, raw));

    files.push({
      id: index,
      path: item.path,
      size,
      downloaded: Math.round(size * progress),
      progress,
      priority,
    });
  });

  return files;
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'https://tracker.gbitt.info:443/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'https://tracker2.ctix.cn:443/announce',
];

const TRACKER_STATUSES: TrackerStatus[] = ['working', 'working', 'updating', 'error'];

export function buildTrackers(torrent: Torrent): TrackerInfo[] {
  const hash = hashString(torrent.name);
  return TRACKERS.map((url, index) => {
    const status = TRACKER_STATUSES[(hash + index) % TRACKER_STATUSES.length];
    return {
      url,
      tier: index < 2 ? 0 : 1,
      status,
      peers: Math.max(0, Math.round((torrent.peersTotal / (index + 2)) % 60)),
      seeds: Math.max(0, Math.round((torrent.seedsTotal / (index + 2)) % 120)),
      nextAnnounceSec: status === 'working' ? 300 + ((hash >> index) % 900) : 0,
      message: status === 'error' ? 'Connection timed out' : '',
    };
  });
}

const PEER_CLIENTS = [
  'qBittorrent 5.0.3',
  'Transmission 4.0.6',
  'libtorrent 2.0.10',
  'Deluge 2.1.1',
  'Tixati 3.29',
  'rTorrent 0.9.8',
  'µTorrent 3.6.0',
];

const PEER_FLAGS = ['D X', 'D', 'U X', 'D U', 'X', 'D U X', '?'];

export function buildPeers(torrent: Torrent): PeerInfo[] {
  const count = 9;
  return Array.from({ length: count }, (_, index) => {
    const seed = hashString(`${torrent.name}:${index}`);
    const address = [
      `192.0.2.${(seed % 240) + 8}`,
      `198.51.100.${(seed % 200) + 10}`,
      `203.0.113.${(seed % 220) + 5}`,
    ][index % 3];
    return {
      address: `${address}:${51413 + (seed % 900)}`,
      client: PEER_CLIENTS[seed % PEER_CLIENTS.length],
      down: Math.round((torrent.downSpeed / count) * (0.3 + (seed % 100) / 80)),
      up: Math.round((torrent.upSpeed / count) * (0.2 + (seed % 100) / 90)),
      progress: Math.min(1, Math.max(0, torrent.progress + ((seed % 21) - 10) / 100)),
      flags: PEER_FLAGS[seed % PEER_FLAGS.length],
    };
  }).sort((a, b) => b.down - a.down);
}
