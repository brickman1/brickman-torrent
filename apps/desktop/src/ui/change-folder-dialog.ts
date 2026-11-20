// "Change download folder" dialog for one torrent.
//
// librqbit 9.1.0 cannot change a torrent's output folder in place, so the core
// removes the torrent, moves the files that are already there and re-adds it at
// the new place (see `Downloader::set_output_dir`). The dialog explains that the
// files are moved and reports how many of them could not be carried over.

import type { TorrentProvider } from '../core/provider';
import type { AppSettings, OutputDirChange, Torrent } from '../core/types';
import { t } from '../i18n';
import { el } from './dom';
import { buildFolderField, checkFolder, errorText } from './folder-field';
import { openModal } from './modal';

export interface ChangeFolderOptions {
  provider: TorrentProvider;
  settings: AppSettings;
  torrent: Torrent;
  onDone: (change: OutputDirChange) => void;
}

export function openChangeFolderDialog(options: ChangeFolderOptions): void {
  const { provider, torrent } = options;

  const folder = buildFolderField({
    provider,
    label: t('folder.label'),
    value: torrent.savePath,
    recent: options.settings.recentFolders,
  });

  const submitError = el('p', { class: 'dialog-error', role: 'alert', hidden: true });

  const body = el(
    'div',
    { class: 'form add-form' },
    el('p', {
      class: 'dialog-text',
      text: t('changeFolder.body', { name: torrent.name }),
    }),
    folder.element,
    el('p', { class: 'hint', text: t('changeFolder.hint') }),
    submitError,
  );

  const submit = async (): Promise<boolean> => {
    submitError.hidden = true;
    folder.clearError();

    const dir = folder.value();
    if (!dir) {
      folder.setError(t('folder.empty'));
      return false;
    }
    const problem = await checkFolder(provider, dir);
    if (problem) {
      folder.setError(problem);
      return false;
    }
    const move = provider.setTorrentOutputDir;
    if (!move) return false;
    try {
      const change = await move.call(provider, torrent.id, dir);
      options.onDone(change);
      return true;
    } catch (error) {
      submitError.textContent = errorText(error);
      submitError.hidden = false;
      return false;
    }
  };

  openModal({
    title: t('changeFolder.title'),
    width: 560,
    body,
    buttons: [
      { label: t('common.cancel') },
      { label: t('changeFolder.apply'), primary: true, onClick: () => submit() },
    ],
  });
}
