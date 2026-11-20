// Download folder control: a path field, a native "Browse…" button, the list of
// recently used folders and an inline error line.
//
// The Tauri commands behind the buttons are optional: in a plain browser there
// is no file manager and no folder dialog, so the field degrades to a plain text
// input (the path can still be typed or pasted with Ctrl+V).

import type { TorrentProvider } from '../core/provider';
import { t } from '../i18n';
import { el } from './dom';

let sequence = 0;

/** Human text of anything thrown by a provider. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface FolderField {
  element: HTMLElement;
  /** Current path, trimmed. */
  value(): string;
  /** Replaces the path and the recent list (no events are fired). */
  setValue(path: string, recent?: readonly string[]): void;
  /** Shows a message under the field and marks it invalid. */
  setError(message: string): void;
  clearError(): void;
  focus(): void;
}

export interface FolderFieldOptions {
  provider: TorrentProvider;
  label: string;
  value: string;
  recent: readonly string[];
  hint?: string;
  /** Called with the picked path (after "Browse…" or a recent entry). */
  onChange?: (path: string) => void;
}

/**
 * Builds the control. "Browse…" asks the app for the native folder dialog;
 * without one (mock runtime) the button is not rendered at all.
 */
export function buildFolderField(options: FolderFieldOptions): FolderField {
  sequence += 1;
  const listId = `folder-recent-${sequence}`;

  const input = el('input', {
    class: 'text-input folder-input',
    type: 'text',
    list: listId,
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: t('folder.placeholder'),
    value: options.value,
  });

  const datalist = el('datalist', { id: listId });
  const fillRecent = (recent: readonly string[]): void => {
    datalist.replaceChildren();
    for (const dir of recent) {
      datalist.appendChild(el('option', { value: dir }));
    }
  };
  fillRecent(options.recent);

  const row = el('div', { class: 'folder-row' }, input);

  const pick = async (): Promise<void> => {
    const folder = options.provider.pickFolder;
    if (!folder) return;
    try {
      const picked = await folder.call(options.provider);
      if (!picked) return;
      input.value = picked;
      options.onChange?.(picked);
    } catch (error) {
      field.setError(errorText(error));
    }
  };

  if (options.provider.pickFolder) {
    const browse = el('button', {
      class: 'btn folder-browse',
      type: 'button',
      title: t('folder.browseHint'),
    });
    browse.textContent = t('folder.browse');
    browse.addEventListener('click', () => void pick());
    row.appendChild(browse);
  }

  const error = el('span', { class: 'field-error', role: 'alert', hidden: true });

  const element = el(
    'div',
    { class: 'field' },
    el('span', { class: 'field-label', text: options.label }),
    row,
    datalist,
    options.hint ? el('span', { class: 'field-hint', text: options.hint }) : null,
    error,
  );

  const field: FolderField = {
    element,
    value: () => input.value.trim(),
    setValue: (path, recent) => {
      input.value = path;
      if (recent) fillRecent(recent);
    },
    setError: (message) => {
      error.textContent = message;
      error.hidden = false;
      input.classList.add('invalid');
    },
    clearError: () => {
      error.textContent = '';
      error.hidden = true;
      input.classList.remove('invalid');
    },
    focus: () => input.focus(),
  };

  input.addEventListener('input', () => field.clearError());
  input.addEventListener('change', () => options.onChange?.(input.value.trim()));

  return field;
}

/**
 * Asks the provider to check the folder. A provider without a checker (mock in
 * a browser) accepts everything: the real check happens on the Rust side.
 */
export async function checkFolder(
  provider: TorrentProvider,
  dir: string,
): Promise<string | null> {
  if (!provider.validateDir) return null;
  try {
    await provider.validateDir.call(provider, dir);
    return null;
  } catch (error) {
    return errorText(error);
  }
}
