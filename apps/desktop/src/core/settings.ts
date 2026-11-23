import { isLocale } from '../i18n';
import type { TorrentProvider } from './provider';
import { normalizeTrackers } from './trackers';
import {
  DEFAULT_SETTINGS,
  RECENT_FOLDERS_LIMIT,
  normalizePeerLimit,
  normalizePowerAction,
  normalizePowerDelay,
  type AppSettings,
  type ColumnWidths,
} from './types';

/**
 * Where versions before the settings store kept the UI settings. It is only
 * read once: the values are handed to the provider and the key is removed.
 */
const STORAGE_KEY = 'brickman-torrent.settings.v1';

/** Reads a stored recent-folders list, dropping anything unusable. */
function readRecentFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const dir = item.trim();
    if (!dir) continue;
    const key = dir.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dir);
    if (result.length >= RECENT_FOLDERS_LIMIT) break;
  }
  return result;
}

/** Reads stored column widths, dropping anything that is not a usable width. */
function readColumnWidths(value: unknown): ColumnWidths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: ColumnWidths = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const px = Math.round(Number(raw));
    if (!Number.isFinite(px) || px <= 0) continue;
    // The per-column minimum is applied by the table, which owns the columns.
    result[key] = Math.min(6000, px);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stored (or defaulted) settings, with every field checked and bounded. */
export function normalizeSettings(stored: unknown): AppSettings {
  const parsed: Partial<AppSettings> = isRecord(stored) ? (stored as Partial<AppSettings>) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    theme: parsed.theme === 'dark' ? 'dark' : 'light',
    locale: isLocale(parsed.locale) ? parsed.locale : 'en',
    checkUpdatesOnStartup: parsed.checkUpdatesOnStartup !== false,
    downloadDir: typeof parsed.downloadDir === 'string' ? parsed.downloadDir : '',
    createSubfolderDefault: parsed.createSubfolderDefault !== false,
    onDownloadsComplete: normalizePowerAction(parsed.onDownloadsComplete),
    powerDelaySecs: normalizePowerDelay(parsed.powerDelaySecs),
    notifyOnComplete: parsed.notifyOnComplete !== false,
    closeToTray: parsed.closeToTray !== false,
    recentFolders: readRecentFolders(parsed.recentFolders),
    columnWidths: readColumnWidths(parsed.columnWidths),
    upnpEnabled: parsed.upnpEnabled !== false,
    utpEnabled: parsed.utpEnabled !== false,
    peerLimit: normalizePeerLimit(parsed.peerLimit),
    extraTrackers: normalizeTrackers(parsed.extraTrackers),
  };
}

/**
 * Settings of versions that only had `localStorage`: they are handed to the
 * provider once and the legacy key is removed, so the migration runs once. The
 * mock provider reads that same key, so in a plain browser this never runs.
 */
async function migrateLegacySettings(provider: TorrentProvider): Promise<unknown> {
  // Without a writer the legacy key is the store itself: nothing to migrate.
  if (!provider.settingsWrite) return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[brickman-torrent] failed to read the legacy settings', err);
    return null;
  }
  if (!raw) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    console.warn('[brickman-torrent] failed to parse the legacy settings', err);
    return null;
  }
  if (!isRecord(parsed)) return null;

  try {
    await provider.settingsWrite(parsed);
  } catch (err) {
    // The values are still used for this session; the legacy copy stays, so a
    // broken store does not lose them.
    console.warn('[brickman-torrent] failed to migrate the legacy settings', err);
    return parsed;
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[brickman-torrent] failed to drop the legacy settings', err);
  }
  return parsed;
}

export async function loadSettings(provider: TorrentProvider): Promise<AppSettings> {
  let stored: unknown = null;
  try {
    stored = (await provider.settingsRead?.()) ?? null;
  } catch (err) {
    console.warn('[brickman-torrent] failed to read the settings', err);
  }
  if (!isRecord(stored)) stored = await migrateLegacySettings(provider);
  return normalizeSettings(stored);
}

export async function saveSettings(
  provider: TorrentProvider,
  settings: AppSettings,
): Promise<void> {
  try {
    await provider.settingsWrite?.(settings);
  } catch (err) {
    console.warn('[brickman-torrent] failed to persist settings', err);
  }
}

export function applyTheme(theme: AppSettings['theme']): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
