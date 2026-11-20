// "Add torrent" dialog: the source (a .torrent file or a magnet link), the
// download folder with its recent list, the per-torrent sub folder and
// "start paused".
//
// The dialog validates the folder before it hands anything to the engine, and
// keeps itself open when the engine reports a problem, so the user sees the
// reason instead of a generic toast.

import type { TorrentProvider } from '../core/provider';
import type { AppSettings, TorrentPreview } from '../core/types';
import { t } from '../i18n';
import { el } from './dom';
import { buildFolderField, checkFolder, errorText } from './folder-field';
import { openModal } from './modal';

export type AddMode = 'file' | 'magnet';

export interface AddDialogRequest {
  mode: AddMode;
  /** `.torrent` path (file mode). */
  filePath: string;
  /** Magnet link (magnet mode). */
  uri: string;
  /** Empty = the folder from the settings. */
  outputDir: string;
  createSubfolder: boolean;
  startPaused: boolean;
  rememberAsDefault: boolean;
}

export interface AddDialogOptions {
  provider: TorrentProvider;
  settings: AppSettings;
  mode: AddMode;
  filePath?: string;
  uri?: string;
  /** Files of the `.torrent` file, when known (decides the sub folder default). */
  preview?: TorrentPreview | null;
  /** System default download folder, shown when the field is empty. */
  defaultDir: string;
  /** Adds the torrent; throwing keeps the dialog open with the message. */
  onSubmit: (request: AddDialogRequest) => Promise<void>;
}

/** The folder the dialog starts with: the last one used, else the settings. */
export function initialFolder(settings: AppSettings): string {
  return settings.recentFolders[0] ?? settings.downloadDir;
}

/**
 * The open add dialog accepts a folder dropped on the window. Only one dialog
 * can be open at a time, so a single slot is enough.
 */
let droppedFolderSlot: ((dir: string) => void) | null = null;

/**
 * Puts a dropped folder into the open add dialog. Returns `false` when no add
 * dialog is open (the caller can then tell the user why nothing happened).
 */
export function useDroppedFolder(dir: string): boolean {
  const apply = droppedFolderSlot;
  if (!apply) return false;
  apply(dir);
  return true;
}

export function openAddDialog(options: AddDialogOptions): void {
  const { provider, settings } = options;
  const mode = options.mode;

  const sourceInput = el('input', {
    class: 'text-input',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    value: mode === 'file' ? options.filePath ?? '' : options.uri ?? '',
    placeholder:
      mode === 'file' ? t('dialog.filePlaceholder') : t('dialog.magnetPlaceholder'),
  });

  const previewHint = el('span', {
    class: 'field-hint',
    text: options.preview
      ? t('add.preview', {
          name: options.preview.name || '—',
          files: String(options.preview.files),
        })
      : mode === 'magnet'
        ? t('dialog.magnetHint')
        : '',
  });

  const folder = buildFolderField({
    provider,
    label: t('folder.label'),
    value: initialFolder(settings),
    recent: settings.recentFolders,
  });
  const pathHint = el('p', { class: 'hint folder-path' });
  folder.element.appendChild(pathHint);

  // Multi-file torrents get their own folder by default, single-file ones do
  // not; with nothing known about the torrent the global default applies.
  const subfolder = el('input', { type: 'checkbox' });
  subfolder.checked =
    options.preview !== undefined && options.preview !== null
      ? options.preview.files > 1
      : settings.createSubfolderDefault;

  const remember = el('input', { type: 'checkbox' });
  const startPaused = el('input', { type: 'checkbox' });

  const updatePathHint = (): void => {
    pathHint.textContent = t('add.saveTo', {
      path: folder.value() || options.defaultDir || t('folder.placeholder'),
    });
  };
  sourceInput.addEventListener('input', () => updatePathHint());
  folder.element.addEventListener('input', updatePathHint);
  updatePathHint();

  const submitError = el('p', { class: 'dialog-error', role: 'alert', hidden: true });
  const showError = (message: string): void => {
    submitError.textContent = message;
    submitError.hidden = false;
  };

  const body = el(
    'div',
    { class: 'form add-form' },
    el(
      'label',
      { class: 'field' },
      el('span', {
        class: 'field-label',
        text: mode === 'file' ? t('dialog.fileLabel') : t('dialog.magnetLabel'),
      }),
      sourceInput,
      previewHint,
    ),
    folder.element,
    el(
      'label',
      { class: 'check-row' },
      subfolder,
      el('span', { text: t('add.subfolder') }),
    ),
    el(
      'label',
      { class: 'check-row' },
      remember,
      el('span', { text: t('add.rememberDefault') }),
    ),
    el(
      'label',
      { class: 'check-row' },
      startPaused,
      el('span', { text: t('add.startPaused') }),
    ),
    submitError,
  );

  const submit = async (): Promise<boolean> => {
    submitError.hidden = true;
    folder.clearError();

    const source = sourceInput.value.trim();
    if (!source) {
      showError(
        mode === 'file' ? t('add.needFile') : t('add.needMagnet'),
      );
      sourceInput.focus();
      return false;
    }
    if (mode === 'magnet' && !source.startsWith('magnet:')) {
      showError(t('add.badMagnet'));
      sourceInput.focus();
      return false;
    }

    const outputDir = folder.value();
    if (outputDir) {
      const problem = await checkFolder(provider, outputDir);
      if (problem) {
        folder.setError(problem);
        return false;
      }
    }

    try {
      await options.onSubmit({
        mode,
        filePath: mode === 'file' ? source : '',
        uri: mode === 'magnet' ? source : '',
        outputDir,
        createSubfolder: subfolder.checked,
        startPaused: startPaused.checked,
        rememberAsDefault: remember.checked,
      });
      return true;
    } catch (error) {
      showError(errorText(error));
      return false;
    }
  };

  const applyDroppedFolder = (dir: string): void => {
    folder.setValue(dir, settings.recentFolders);
    updatePathHint();
  };

  openModal({
    title: mode === 'file' ? t('dialog.addFileTitle') : t('dialog.magnetTitle'),
    width: 560,
    body,
    buttons: [
      { label: t('common.cancel') },
      { label: t('common.add'), primary: true, onClick: () => submit() },
    ],
    onClose: () => {
      if (droppedFolderSlot === applyDroppedFolder) droppedFolderSlot = null;
    },
  });

  // Assigned after `openModal`, which closes a dialog that is still open and
  // lets that one clear its own slot.
  droppedFolderSlot = applyDroppedFolder;
}
