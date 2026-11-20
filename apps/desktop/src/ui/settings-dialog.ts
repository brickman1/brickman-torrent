// Settings form (files, queue, bandwidth, updates, appearance).

import type { TorrentProvider } from '../core/provider';
import {
  POWER_DELAY_MAX,
  POWER_DELAY_MIN,
  normalizePowerAction,
  normalizePowerDelay,
  withRecentFolder,
  type AppSettings,
} from '../core/types';
import { t } from '../i18n';
import { el } from './dom';
import { buildFolderField } from './folder-field';

export interface SettingsFormOptions {
  isMock: boolean;
  mockUpdateAvailable: boolean;
  onMockUpdateChange: (available: boolean) => void;
  /** Mock only: pretends every download just finished (power settings demo). */
  onMockFinishDownloads: () => void;
  version: string;
  provider: TorrentProvider;
  /** System default download folder, shown when the field is empty. */
  defaultDir: string;
}

export interface SettingsForm {
  body: HTMLElement;
  read: () => AppSettings;
}

function numberInput(value: number, min: number, max: number): HTMLInputElement {
  const input = el('input', {
    class: 'text-input',
    type: 'number',
    min,
    max,
    step: 1,
    value: String(value),
  });
  return input;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label', text: label }),
    control,
    hint ? el('span', { class: 'field-hint', text: hint }) : null,
  );
}

function checkbox(value: boolean): HTMLInputElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = value;
  return input;
}

function selectOption(value: string, label: string): HTMLOptionElement {
  const option = el('option', { value }, label);
  return option;
}

export function buildSettingsForm(
  settings: AppSettings,
  options: SettingsFormOptions,
): SettingsForm {
  const maxActive = numberInput(settings.maxActive, 1, 50);
  const downLimit = numberInput(settings.downLimit, 0, 1000000);
  const upLimit = numberInput(settings.upLimit, 0, 1000000);
  const checkUpdates = checkbox(settings.checkUpdatesOnStartup);
  const createSubfolder = checkbox(settings.createSubfolderDefault);

  // Empty = the system default (Downloads); the Rust side resolves it.
  const folder = buildFolderField({
    provider: options.provider,
    label: t('settings.downloadDir'),
    value: settings.downloadDir,
    recent: settings.recentFolders,
    hint: t('settings.downloadDirHint'),
  });

  // Full path of what will be used, plus a way to look at it right now.
  const pathHint = el('span', { class: 'hint folder-path' });
  const openFolder = el('button', { class: 'btn folder-browse', type: 'button' });
  openFolder.textContent = t('folder.open');
  const resolvedDir = (): string => folder.value() || options.defaultDir;
  const updatePathHint = (): void => {
    pathHint.textContent = resolvedDir();
  };
  openFolder.addEventListener('click', () => {
    void options.provider
      .openFolder?.({ path: resolvedDir() })
      .catch((error: unknown) => console.error('[brickman-torrent] cannot open folder', error));
  });
  if (!options.provider.openFolder) openFolder.disabled = true;
  updatePathHint();
  folder.element.addEventListener('input', updatePathHint);
  folder.element.appendChild(
    el('div', { class: 'folder-hint-row' }, pathHint, openFolder),
  );

  const theme = el(
    'select',
    { class: 'text-input select-input' },
    selectOption('light', t('settings.light')),
    selectOption('dark', t('settings.dark')),
  );
  theme.value = settings.theme;

  const language = el(
    'select',
    { class: 'text-input select-input' },
    selectOption('en', 'English'),
    selectOption('ru', 'Русский'),
  );
  language.value = settings.locale;

  const mockCheckbox = checkbox(options.mockUpdateAvailable);
  mockCheckbox.addEventListener('change', () => {
    options.onMockUpdateChange(mockCheckbox.checked);
  });

  const mockFinish = el('button', {
    class: 'btn mock-finish',
    type: 'button',
    text: t('settings.mockFinish'),
  });
  mockFinish.addEventListener('click', () => options.onMockFinishDownloads());

  // "Power off when downloads finish": the action, its delay and the warning
  // that only the force variant is allowed to lose unsaved work.
  const powerAction = el(
    'select',
    { class: 'text-input select-input power-action' },
    selectOption('nothing', t('settings.powerNone')),
    selectOption('sleep', t('settings.powerSleep')),
    selectOption('hibernate', t('settings.powerHibernate')),
    selectOption('shutdown', t('settings.powerShutdown')),
    selectOption('force-shutdown', t('settings.powerForceShutdown')),
  );
  powerAction.value = settings.onDownloadsComplete;

  const powerDelay = numberInput(settings.powerDelaySecs, POWER_DELAY_MIN, POWER_DELAY_MAX);
  powerDelay.classList.add('power-delay');

  const powerWarning = el('p', {
    class: 'hint power-warning',
    text: t('settings.powerForceWarning'),
  });
  const updatePowerWarning = (): void => {
    powerWarning.hidden = powerAction.value !== 'force-shutdown';
  };
  powerAction.addEventListener('change', updatePowerWarning);
  updatePowerWarning();

  const body = el(
    'div',
    { class: 'settings-form' },
    el('div', { class: 'settings-section', text: t('settings.sectionFiles') }),
    folder.element,
    el(
      'label',
      { class: 'check-row' },
      createSubfolder,
      el('span', { text: t('settings.createSubfolder') }),
    ),
    el('p', { class: 'hint', text: t('settings.createSubfolderHint') }),

    el('div', { class: 'settings-section', text: t('settings.sectionQueue') }),
    field(t('settings.maxActive'), maxActive, t('settings.maxActiveHint')),

    el('div', { class: 'settings-section', text: t('settings.sectionPower') }),
    field(t('settings.powerAction'), powerAction, t('settings.powerActionHint')),
    field(t('settings.powerDelay'), powerDelay, t('settings.powerDelayHint')),
    powerWarning,

    el('div', { class: 'settings-section', text: t('settings.sectionBandwidth') }),
    field(t('settings.downLimit'), downLimit, t('settings.limitHint')),
    field(t('settings.upLimit'), upLimit, t('settings.limitHint')),

    el('div', { class: 'settings-section', text: t('settings.sectionUpdates') }),
    el(
      'label',
      { class: 'check-row' },
      checkUpdates,
      el('span', { text: t('settings.checkUpdates') }),
    ),
    el('p', { class: 'hint', text: t('settings.checkUpdatesHint') }),
    options.isMock
      ? el(
          'div',
          { class: 'mock-box' },
          el(
            'label',
            { class: 'check-row' },
            mockCheckbox,
            el('span', { text: t('settings.mockUpdate') }),
          ),
          el('p', { class: 'hint', text: t('settings.mockUpdateHint') }),
          mockFinish,
        )
      : null,

    el('div', { class: 'settings-section', text: t('settings.sectionAppearance') }),
    field(t('settings.theme'), theme),
    field(t('settings.language'), language),

    el('div', { class: 'settings-version', text: t('settings.version', { version: options.version }) }),
  );

  const read = (): AppSettings => {
    const downloadDir = folder.value();
    // A folder typed here is a folder the user works with: keep it in the
    // recent list of the add dialog as well.
    const recentFolders = downloadDir
      ? withRecentFolder(settings.recentFolders, downloadDir)
      : settings.recentFolders;
    return {
      theme: theme.value === 'dark' ? 'dark' : 'light',
      locale: language.value === 'ru' ? 'ru' : 'en',
      checkUpdatesOnStartup: checkUpdates.checked,
      maxActive: Math.min(50, Math.max(1, Number(maxActive.value) || settings.maxActive)),
      downLimit: Math.max(0, Number(downLimit.value) || 0),
      upLimit: Math.max(0, Number(upLimit.value) || 0),
      downloadDir,
      createSubfolderDefault: createSubfolder.checked,
      onDownloadsComplete: normalizePowerAction(powerAction.value),
      powerDelaySecs: normalizePowerDelay(powerDelay.value),
      recentFolders,
    };
  };

  return { body, read };
}
