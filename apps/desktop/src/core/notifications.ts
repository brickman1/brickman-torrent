// System notification when a download finishes.
//
// The Tauri notification plugin is loaded only inside the webview: a plain
// browser (mock data) has no system notifications, so `notifyCompletion`
// answers `false` and the caller shows its own toast instead.

import { t } from '../i18n';
import { isTauri } from './tauri-provider';

export interface CompletionNotice {
  /** Torrent id: the "Open folder" action has to know what to open. */
  id: string;
  name: string;
  /** Where the torrent was saved; the notification body shows it. */
  folder: string;
}

/** Action type registered with the plugin: a single "Open folder" button. */
const ACTION_TYPE = 'download-complete';
const OPEN_FOLDER_ACTION = 'open-folder';
/** The plugin reports a click on the notification itself with this id. */
const TAP_ACTION = 'tap';

/** What the action button does; the app knows how to open a torrent folder. */
let openFolderHandler: ((id: string) => void) | null = null;
/** Permission, action types and the action listener are set up once. */
let prepared: Promise<boolean> | null = null;

export function setCompletionActionHandler(handler: ((id: string) => void) | null): void {
  openFolderHandler = handler;
}

/**
 * Asks for the permission once and registers the action type: a notification
 * shown without a registered action type has no buttons and no click event.
 */
async function prepare(): Promise<boolean> {
  const { isPermissionGranted, requestPermission, registerActionTypes, onAction } = await import(
    '@tauri-apps/plugin-notification'
  );

  if (!(await isPermissionGranted())) {
    const permission = await requestPermission();
    if (permission !== 'granted') return false;
  }

  await registerActionTypes([
    {
      id: ACTION_TYPE,
      actions: [{ id: OPEN_FOLDER_ACTION, title: t('notify.openFolder') }],
    },
  ]);

  await onAction((event) => {
    if (event.actionId !== OPEN_FOLDER_ACTION && event.actionId !== TAP_ACTION) return;
    // The extra payload is where the torrent id travels; the plugin hands it
    // back as `unknown`, so it is checked before use.
    const id = event.notification?.extra?.torrentId;
    if (typeof id === 'string') openFolderHandler?.(id);
  });

  return true;
}

/**
 * Shows "<name> finished downloading" with the folder in the body and an
 * "Open folder" button.
 *
 * Resolves to `false` when there is no native notification to show: a browser
 * (mock data), the plugin is missing, or the user refused the permission.
 */
export async function notifyCompletion(notice: CompletionNotice): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    if (!prepared) prepared = prepare();
    if (!(await prepared)) return false;

    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    sendNotification({
      title: t('notify.title'),
      body: `${t('notify.completed', { name: notice.name })}\n${notice.folder}`,
      actionTypeId: ACTION_TYPE,
      extra: { torrentId: notice.id },
    });
    return true;
  } catch (err) {
    console.warn('[brickman-torrent] cannot show a notification', err);
    return false;
  }
}
