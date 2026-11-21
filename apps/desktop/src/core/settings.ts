import { isLocale } from '../i18n';
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

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, recentFolders: [] };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
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
      recentFolders: readRecentFolders(parsed.recentFolders),
      columnWidths: readColumnWidths(parsed.columnWidths),
      upnpEnabled: parsed.upnpEnabled !== false,
      utpEnabled: parsed.utpEnabled !== false,
      peerLimit: normalizePeerLimit(parsed.peerLimit),
      extraTrackers: normalizeTrackers(parsed.extraTrackers),
    };
  } catch (err) {
    console.warn('[brickman-torrent] failed to read settings', err);
    return { ...DEFAULT_SETTINGS, recentFolders: [] };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[brickman-torrent] failed to persist settings', err);
  }
}

export function applyTheme(theme: AppSettings['theme']): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
