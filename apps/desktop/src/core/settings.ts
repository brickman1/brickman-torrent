import {
  DEFAULT_SETTINGS,
  RECENT_FOLDERS_LIMIT,
  normalizePowerAction,
  normalizePowerDelay,
  type AppSettings,
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

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, recentFolders: [] };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
      locale: parsed.locale === 'ru' ? 'ru' : 'en',
      checkUpdatesOnStartup: parsed.checkUpdatesOnStartup !== false,
      downloadDir: typeof parsed.downloadDir === 'string' ? parsed.downloadDir : '',
      createSubfolderDefault: parsed.createSubfolderDefault !== false,
      onDownloadsComplete: normalizePowerAction(parsed.onDownloadsComplete),
      powerDelaySecs: normalizePowerDelay(parsed.powerDelaySecs),
      recentFolders: readRecentFolders(parsed.recentFolders),
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
