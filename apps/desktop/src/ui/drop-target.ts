// HTML5 drag and drop of `.torrent` files and magnet links on the whole window.
//
// The native `onDragDropEvent` of Tauri is deliberately not used: it replaces
// the WebView2 drop handler and would cut the HTML5 drag and drop the torrent
// table already relies on. The window is built with `"dragDropEnabled": false`
// instead, so the webview keeps its own drag and drop.
//
// A dropped file has no usable path inside a webview, so the bytes are handed
// over and the caller stages them into a real file (see the
// `stageDroppedTorrent` provider method).

import { t } from '../i18n';
import { el } from './dom';

export interface DroppedTorrent {
  /** Name the drop reported (`ubuntu.iso.torrent`). */
  name: string;
  /** Real path, when the webview exposes one. */
  path?: string;
  /** File content, used when there is no path. */
  bytes?: Uint8Array;
}

export interface TorrentDropOptions {
  /** `.torrent` files were dropped (one or several). */
  onTorrents(dropped: DroppedTorrent[]): void;
  /** A `magnet:` link was dropped as text. */
  onMagnet(uri: string): void;
  /** Files were dropped, but none of them is a `.torrent` file. */
  onUnsupported(): void;
}

const TORRENT_NAME = /\.torrent$/i;
/** Windows registers this type for `.torrent`; some browsers report nothing. */
const TORRENT_TYPE = 'application/x-bittorrent';
const OVERLAY_CLASS = 'drop-overlay';
const VISIBLE_CLASS = 'visible';

/** Non-standard `path` of a dropped file: available in some webviews only. */
function filePath(file: File): string | undefined {
  const path = (file as File & { path?: unknown }).path;
  return typeof path === 'string' && path.trim() !== '' ? path : undefined;
}

/** A `file:///C:/…` entry of the drag payload, when the platform offers one. */
function uriPath(text: string): string | undefined {
  const match = /^file:\/\/\/(.+)$/m.exec(text.trim());
  if (!match?.[1]) return undefined;
  try {
    const decoded = decodeURIComponent(match[1]);
    // `file:///C:/…` is the Windows form; anything else keeps its leading `/`.
    return /^[A-Za-z]:\//.test(decoded) ? decoded.replace(/\//g, '\\') : `/${decoded}`;
  } catch {
    return undefined;
  }
}

function isTorrentFile(file: File): boolean {
  return TORRENT_NAME.test(file.name) || file.type === TORRENT_TYPE;
}

/** First `magnet:` link of the dragged text (a URI list has one per line). */
function magnetLink(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (value.toLowerCase().startsWith('magnet:')) return value;
  }
  return undefined;
}

/** Text of the drag: the first non-empty of the two plain-text flavours. */
function dragText(data: DataTransfer): string {
  for (const type of ['text/uri-list', 'text/plain']) {
    try {
      const value = data.getData(type).trim();
      if (value !== '') return value;
    } catch {
      // An unreadable flavour is not an error, the next one is tried.
    }
  }
  return '';
}

/** A text field keeps its own drop (dragging a link into it is a paste). */
function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, [contenteditable="true"]') !== null
  );
}

/**
 * Listens on the document and calls back with whatever was dropped.
 *
 * Returns the function that removes the listeners and the overlay again.
 */
export function attachTorrentDrop(options: TorrentDropOptions): () => void {
  let depth = 0;
  let draggingInside = false;
  let overlay: HTMLElement | null = null;

  /** A drag this window should react to: files, or text that may be a magnet. */
  const candidate = (data: DataTransfer | null): boolean => {
    if (!data) return false;
    const types = Array.from(data.types);
    if (types.includes('Files')) return true;
    // The content of a text drag is not readable before the drop, so any
    // text from outside the window counts as a possible magnet link; a drag
    // started in the app itself (a table row) is not one.
    return !draggingInside && (types.includes('text/uri-list') || types.includes('text/plain'));
  };

  const ensureOverlay = (): HTMLElement => {
    if (overlay) return overlay;
    overlay = el(
      'div',
      { class: OVERLAY_CLASS, 'aria-hidden': 'true' },
      el('div', { class: 'drop-overlay-box', text: t('drop.hint') }),
    );
    document.body.appendChild(overlay);
    return overlay;
  };

  const showOverlay = (): void => {
    ensureOverlay().classList.add(VISIBLE_CLASS);
  };

  const hideOverlay = (): void => {
    depth = 0;
    overlay?.classList.remove(VISIBLE_CLASS);
  };

  /** Reads the dropped files, filling in the bytes when there is no path. */
  const collect = async (files: File[], text: string): Promise<DroppedTorrent[]> => {
    const sharedPath = files.length === 1 ? uriPath(text) : undefined;
    const dropped: DroppedTorrent[] = [];
    for (const file of files) {
      const path = filePath(file) ?? sharedPath;
      if (path) {
        dropped.push({ name: file.name, path });
        continue;
      }
      try {
        dropped.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      } catch (err) {
        console.warn('[brickman-torrent] cannot read the dropped file', err);
      }
    }
    return dropped;
  };

  const onDragStart = (): void => {
    draggingInside = true;
  };

  const onDragEnd = (): void => {
    draggingInside = false;
    hideOverlay();
  };

  const onDragEnter = (event: DragEvent): void => {
    if (!candidate(event.dataTransfer)) return;
    depth += 1;
    showOverlay();
  };

  const onDragOver = (event: DragEvent): void => {
    const data = event.dataTransfer;
    if (!candidate(data)) return;
    const hasFiles = Array.from(data?.types ?? []).includes('Files');
    if (!hasFiles && isTextField(event.target)) return;
    if (data) data.dropEffect = 'copy';
    // Without this the browser refuses the drop and no `drop` event follows.
    event.preventDefault();
    showOverlay();
  };

  const onDragLeave = (event: DragEvent): void => {
    if (!candidate(event.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay?.classList.remove(VISIBLE_CLASS);
  };

  const onDrop = (event: DragEvent): void => {
    const data = event.dataTransfer;
    const wasInside = draggingInside;
    hideOverlay();
    draggingInside = false;
    if (!data) return;
    const hasFiles = Array.from(data.types).includes('Files');
    // A row dragged inside the window is a queue edit, not an add.
    if (wasInside && !hasFiles) return;

    const files = Array.from(data.files ?? []);
    const torrents = files.filter(isTorrentFile);
    // Everything has to be read now: the payload is empty after the event.
    const text = dragText(data);
    const magnet = magnetLink(text);

    if (torrents.length > 0) {
      event.preventDefault();
      void collect(torrents, text).then((dropped) => {
        if (dropped.length > 0) options.onTorrents(dropped);
        else if (magnet) options.onMagnet(magnet);
        else options.onUnsupported();
      });
      return;
    }
    if (magnet) {
      event.preventDefault();
      options.onMagnet(magnet);
      return;
    }
    if (files.length > 0) {
      event.preventDefault();
      options.onUnsupported();
    }
  };

  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragend', onDragEnd);
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);

  return () => {
    document.removeEventListener('dragstart', onDragStart);
    document.removeEventListener('dragend', onDragEnd);
    document.removeEventListener('dragenter', onDragEnter);
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('drop', onDrop);
    overlay?.remove();
    overlay = null;
  };
}
