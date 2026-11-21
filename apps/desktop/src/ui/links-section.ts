// "Links" settings section: whether the app opens `magnet:` links and
// `.torrent` files, and the two buttons that change it.
//
// The buttons act immediately instead of waiting for "Apply": the registration
// lives in the Windows registry, not in the app settings. A failure comes back
// inside the status (`error`), so it is shown here and not as a toast.

import type { TorrentProvider } from '../core/provider';
import type { HandlerStatus } from '../core/types';
import { t } from '../i18n';
import { el } from './dom';
import { errorText } from './folder-field';

export function buildLinksSection(provider: TorrentProvider): HTMLElement {
  const readStatus = provider.handlerStatus;
  const doRegister = provider.handlerRegister;
  const doUnregister = provider.handlerUnregister;
  const doOpenDefaultApps = provider.openDefaultApps;

  const dot = el('span', { class: 'links-dot' });
  const statusText = el('span', { class: 'links-status-text', text: t('settings.linksChecking') });

  const register = el('button', {
    class: 'btn links-register',
    type: 'button',
    text: t('settings.linksRegister'),
  });
  const unregister = el('button', {
    class: 'btn links-unregister',
    type: 'button',
    text: t('settings.linksUnregister'),
  });
  const openSettings = el('button', {
    class: 'btn links-open-settings',
    type: 'button',
    text: t('settings.linksOpenSettings'),
  });

  const error = el('p', { class: 'field-error links-error', role: 'alert', hidden: true });

  const showError = (message: string | undefined): void => {
    error.textContent = message ?? '';
    error.hidden = !message;
  };

  /** Renders one answer of the engine; the buttons follow it. */
  const apply = (status: HandlerStatus): void => {
    dot.classList.toggle('ok', status.registered);
    statusText.textContent = status.registered
      ? t('settings.linksRegistered')
      : t('settings.linksNotRegistered');
    register.disabled = status.registered;
    // Without a backup there is nothing to restore: hide the button instead of
    // offering an action that would silently do nothing.
    unregister.hidden = !status.backupPresent;
    unregister.disabled = false;
    showError(status.error);
  };

  const refresh = async (): Promise<void> => {
    if (!readStatus) return;
    try {
      apply(await readStatus.call(provider));
    } catch (err) {
      showError(errorText(err));
      register.disabled = true;
      unregister.hidden = true;
    }
  };

  const run = async (action: () => Promise<HandlerStatus>): Promise<void> => {
    register.disabled = true;
    unregister.disabled = true;
    try {
      apply(await action());
    } catch (err) {
      showError(errorText(err));
      // Ask again instead of guessing which buttons to re-enable.
      await refresh();
    }
  };

  if (doRegister) {
    register.addEventListener('click', () => void run(() => doRegister.call(provider)));
  } else {
    register.hidden = true;
  }
  if (doUnregister) {
    unregister.addEventListener('click', () => void run(() => doUnregister.call(provider)));
  } else {
    unregister.hidden = true;
  }
  if (doOpenDefaultApps) {
    openSettings.addEventListener('click', () => {
      void doOpenDefaultApps
        .call(provider)
        .catch((err: unknown) => showError(errorText(err)));
    });
  } else {
    openSettings.hidden = true;
  }

  const element = el(
    'div',
    { class: 'links-box' },
    el(
      'div',
      { class: 'check-row links-status-row' },
      dot,
      el('span', { class: 'links-label', text: t('settings.linksHandler') }),
      statusText,
    ),
    el('div', { class: 'links-actions' }, register, unregister),
    openSettings,
    error,
    el('p', { class: 'hint', text: t('settings.linksResetHint') }),
  );

  void refresh();
  return element;
}
