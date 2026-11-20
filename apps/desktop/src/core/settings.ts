import { DEFAULT_SETTINGS, type AppSettings } from './types';

const STORAGE_KEY = 'brickman-torrent.settings.v1';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
      locale: parsed.locale === 'ru' ? 'ru' : 'en',
      checkUpdatesOnStartup: parsed.checkUpdatesOnStartup !== false,
      downloadDir: typeof parsed.downloadDir === 'string' ? parsed.downloadDir : '',
    };
  } catch (err) {
    console.warn('[brickman-torrent] failed to read settings', err);
    return { ...DEFAULT_SETTINGS };
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
