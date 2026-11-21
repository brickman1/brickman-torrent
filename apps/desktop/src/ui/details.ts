// Bottom details panel: General / Files / Trackers / Peers.

import {
  formatDateTime,
  formatEta,
  formatPercent,
  formatRatio,
  formatSize,
  formatSpeed,
} from '../core/format';
import {
  effectiveStatus,
  type FilePriority,
  type PeerInfo,
  type Torrent,
  type TorrentFile,
  type TrackerInfo,
} from '../core/types';
import { t } from '../i18n';
import { clear, el } from './dom';

export type DetailTab = 'general' | 'files' | 'trackers' | 'peers';

export const DETAIL_TABS: { id: DetailTab; labelKey: string }[] = [
  { id: 'general', labelKey: 'tab.general' },
  { id: 'files', labelKey: 'tab.files' },
  { id: 'trackers', labelKey: 'tab.trackers' },
  { id: 'peers', labelKey: 'tab.peers' },
];

export interface DetailsContext {
  torrent: Torrent | null;
  tab: DetailTab;
  files: TorrentFile[];
  trackers: TrackerInfo[];
  peers: PeerInfo[];
  onTab: (tab: DetailTab) => void;
  onFilePriority: (fileId: number, priority: FilePriority) => void;
  onAllFiles: (priority: FilePriority) => void;
}

const scrollMemory = new WeakMap<HTMLElement, number>();

function miniBar(progress: number, status?: string): HTMLElement {
  const pct = Math.min(100, Math.max(0, progress * 100));
  return el(
    'div',
    { class: `prog prog-small${status ? ` prog-${status}` : ''}${progress >= 1 ? ' complete' : ''}` },
    el('div', { class: 'prog-track' }, el('div', { class: 'prog-fill', style: `width:${pct.toFixed(2)}%` })),
    el('span', { class: 'prog-text', text: formatPercent(progress) }),
  );
}

function priorityLabel(priority: FilePriority): string {
  return priority === -1 ? t('files.skip') : t('files.download');
}

export function renderDetails(container: HTMLElement, ctx: DetailsContext): void {
  const previousBody = container.querySelector<HTMLElement>('.details-body');
  if (previousBody) scrollMemory.set(container, previousBody.scrollTop);

  clear(container);

  const tabs = el('div', { class: 'details-tabs', role: 'tablist' });
  for (const tab of DETAIL_TABS) {
    const button = el(
      'button',
      {
        class: `dt-tab${ctx.tab === tab.id ? ' active' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': ctx.tab === tab.id ? 'true' : 'false',
      },
      t(tab.labelKey),
    );
    button.addEventListener('click', () => ctx.onTab(tab.id));
    tabs.appendChild(button);
  }
  tabs.appendChild(el('div', { class: 'details-tabs-spacer' }));

  const body = el('div', { class: 'details-body' });
  if (!ctx.torrent) {
    body.appendChild(el('div', { class: 'details-empty', text: t('details.noSelection') }));
  } else if (ctx.tab === 'general') {
    body.appendChild(generalTab(ctx.torrent));
  } else if (ctx.tab === 'files') {
    body.appendChild(filesTab(ctx));
  } else if (ctx.tab === 'trackers') {
    body.appendChild(trackersTab(ctx.trackers));
  } else {
    body.appendChild(peersTab(ctx.peers));
  }

  container.appendChild(tabs);
  container.appendChild(body);
  body.scrollTop = scrollMemory.get(container) ?? 0;
}

function kv(label: string, value: Node | string, wide = false): HTMLElement[] {
  return [
    el('div', { class: `kv-key${wide ? ' wide' : ''}`, text: label }),
    el('div', { class: `kv-value${wide ? ' wide' : ''}` }, value),
  ];
}

function generalTab(torrent: Torrent): HTMLElement {
  const status = effectiveStatus(torrent);

  const grid = el(
    'div',
    { class: 'kv-grid' },
    ...kv('Name', torrent.name),
    ...kv('Hash', el('span', { class: 'mono', text: torrent.hash })),
    ...kv('Status', el('span', { class: `status st-${status}`, text: t(`status.${status}`) })),
    ...kv('Size', formatSize(torrent.size)),
    ...kv('Downloaded', `${formatSize(torrent.downloaded)} (${formatPercent(torrent.progress)})`),
    ...kv('Uploaded', formatSize(torrent.uploaded)),
    ...kv('Ratio', formatRatio(torrent.ratio)),
    ...kv('Seeds', `${torrent.seeds} (${torrent.seedsTotal})`),
    ...kv('Peers', `${torrent.peers} (${torrent.peersTotal})`),
    ...kv('Pieces', `${torrent.pieces.have} / ${torrent.pieces.total}`),
    ...kv('Connections', String(torrent.connections)),
    ...kv('Added', formatDateTime(torrent.addedAt)),
    ...kv('Priority', `#${torrent.priority}`),
    ...kv('Label', torrent.label || '—'),
    ...kv('Down speed', formatSpeed(torrent.downSpeed)),
    ...kv('Up speed', formatSpeed(torrent.upSpeed)),
    ...kv('ETA', formatEta(torrent.etaSec)),
    ...kv('Save path', el('span', { class: 'mono', text: torrent.savePath }), true),
    ...(torrent.comment ? kv('Comment', torrent.comment, true) : []),
  );

  return el(
    'div',
    { class: 'general-tab' },
    el('div', { class: 'general-head' }, el('span', { class: 'general-name', text: torrent.name }), miniBar(torrent.progress, status)),
    grid,
  );
}

function filesTab(ctx: DetailsContext): HTMLElement {
  const files = ctx.files;
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const allChecked = files.length > 0 && files.every((file) => file.priority !== -1);
  const someChecked = files.some((file) => file.priority !== -1);

  const headCheckbox = el('input', {
    type: 'checkbox',
    'aria-label': t('files.selectAll'),
  });
  headCheckbox.checked = allChecked;
  headCheckbox.indeterminate = !allChecked && someChecked;
  headCheckbox.addEventListener('change', () => {
    ctx.onAllFiles(headCheckbox.checked ? 1 : -1);
  });

  // One checkbox per file: the engine selects files by inclusion, so there are
  // exactly two states — download or don't download.
  const rows = files.map((file) => {
    const checkbox = el('input', {
      type: 'checkbox',
      'aria-label': file.path,
    });
    checkbox.checked = file.priority !== -1;
    checkbox.addEventListener('change', () => {
      ctx.onFilePriority(file.id, checkbox.checked ? 1 : -1);
    });

    const download = el(
      'label',
      { class: 'file-download' },
      checkbox,
      el('span', { text: priorityLabel(file.priority) }),
    );

    return el(
      'tr',
      { class: file.priority === -1 ? 'skipped' : '' },
      el('td', { class: 'path', title: file.path, text: file.path }),
      el('td', { class: 'num' }, formatSize(file.size)),
      el('td', { class: 'progress-cell' }, miniBar(file.progress)),
      el('td', { class: 'prio-cell' }, download),
    );
  });

  const table = el(
    'table',
    { class: 'grid-table files-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { class: 'left', text: t('files.name') }),
        el('th', { class: 'num', text: t('files.size') }),
        el('th', { class: 'progress-col', text: t('files.progress') }),
        el(
          'th',
          { class: 'left prio-col' },
          headCheckbox,
          el('span', { class: 'th-text', text: t('files.download') }),
        ),
      ),
    ),
    el('tbody', {}, ...rows),
  );

  return el(
    'div',
    { class: 'files-tab' },
    el(
      'div',
      { class: 'files-summary' },
      el('span', { text: t('files.count', { count: files.length }) }),
      el('span', { class: 'sep' }, '·'),
      el('span', { text: formatSize(totalSize) }),
    ),
    table,
  );
}

function trackersTab(trackers: TrackerInfo[]): HTMLElement {
  const rows = trackers.map((tracker) =>
    el(
      'tr',
      {},
      el('td', { class: 'path', title: tracker.url, text: tracker.url }),
      el(
        'td',
        {},
        el('span', {
          class: `tracker-status ts-${tracker.status}`,
          text: t(`tracker.${tracker.status}`),
        }),
      ),
      el('td', { class: 'num' }, String(tracker.peers)),
      el('td', { class: 'num' }, String(tracker.seeds)),
      el('td', { class: 'num' }, tracker.nextAnnounceSec ? formatEta(tracker.nextAnnounceSec) : '—'),
    ),
  );

  return el(
    'table',
    { class: 'grid-table trackers-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { class: 'left', text: t('trackers.url') }),
        el('th', { class: 'left', text: t('trackers.status') }),
        el('th', { class: 'num', text: t('trackers.peers') }),
        el('th', { class: 'num', text: t('trackers.seeds') }),
        el('th', { class: 'num', text: t('trackers.nextAnnounce') }),
      ),
    ),
    el('tbody', {}, ...rows),
  );
}

function peersTab(peers: PeerInfo[]): HTMLElement {
  const rows = peers.map((peer) =>
    el(
      'tr',
      {},
      el('td', { class: 'mono', text: peer.address }),
      el('td', { class: 'left', text: peer.client }),
      el('td', { class: 'num' }, formatSpeed(peer.down)),
      el('td', { class: 'num' }, formatSpeed(peer.up)),
      el('td', { class: 'progress-cell' }, miniBar(peer.progress)),
      el('td', { class: 'flags', text: peer.flags }),
    ),
  );

  return el(
    'table',
    { class: 'grid-table peers-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { class: 'left', text: t('peers.address') }),
        el('th', { class: 'left', text: t('peers.client') }),
        el('th', { class: 'num', text: t('peers.down') }),
        el('th', { class: 'num', text: t('peers.up') }),
        el('th', { class: 'progress-col', text: t('peers.progress') }),
        el('th', { class: 'left', text: t('peers.flags') }),
      ),
    ),
    el('tbody', {}, ...rows),
  );
}
