// Settings form (queue, bandwidth, updates, appearance).

import type { AppSettings } from '../core/types';
import { t } from '../i18n';
import { el } from './dom';

export interface SettingsFormOptions {
  isMock: boolean;
  mockUpdateAvailable: boolean;
  onMockUpdateChange: (available: boolean) => void;
  version: string;
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

  // Empty = the system default (Downloads); the Rust side resolves it.
  const downloadDir = el('input', {
    class: 'text-input',
    type: 'text',
    placeholder: t('settings.downloadDirPlaceholder'),
    value: settings.downloadDir,
  });

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

  const body = el(
    'div',
    { class: 'settings-form' },
    el('div', { class: 'settings-section', text: t('settings.sectionFiles') }),
    field(t('settings.downloadDir'), downloadDir, t('settings.downloadDirHint')),

    el('div', { class: 'settings-section', text: t('settings.sectionQueue') }),
    field(t('settings.maxActive'), maxActive, t('settings.maxActiveHint')),

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
        )
      : null,

    el('div', { class: 'settings-section', text: t('settings.sectionAppearance') }),
    field(t('settings.theme'), theme),
    field(t('settings.language'), language),

    el('div', { class: 'settings-version', text: t('settings.version', { version: options.version }) }),
  );

  const read = (): AppSettings => ({
    theme: theme.value === 'dark' ? 'dark' : 'light',
    locale: language.value === 'ru' ? 'ru' : 'en',
    checkUpdatesOnStartup: checkUpdates.checked,
    maxActive: Math.min(50, Math.max(1, Number(maxActive.value) || settings.maxActive)),
    downLimit: Math.max(0, Number(downLimit.value) || 0),
    upLimit: Math.max(0, Number(upLimit.value) || 0),
    downloadDir: downloadDir.value.trim(),
  });

  return { body, read };
}
