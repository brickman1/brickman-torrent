// Torrent table: fixed columns, 24 px rows, click-to-sort headers.

import { formatEta, formatPercent, formatSize, formatSpeed } from '../core/format';
import { effectiveStatus, type Torrent } from '../core/types';
import { t } from '../i18n';
import { clear, el } from './dom';

export type SortKey =
  | 'ordinal'
  | 'name'
  | 'size'
  | 'status'
  | 'progress'
  | 'downSpeed'
  | 'upSpeed'
  | 'seeds'
  | 'peers'
  | 'eta'
  | 'priority'
  | 'label';

export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

export interface ColumnDef {
  key: string;
  sortKey: SortKey;
  labelKey: string;
  width: string;
  align: 'left' | 'right';
}

export const COLUMNS: ColumnDef[] = [
  { key: 'ordinal', sortKey: 'ordinal', labelKey: 'column.index', width: '3%', align: 'right' },
  { key: 'name', sortKey: 'name', labelKey: 'column.name', width: '26.5%', align: 'left' },
  { key: 'size', sortKey: 'size', labelKey: 'column.size', width: '7%', align: 'right' },
  { key: 'status', sortKey: 'status', labelKey: 'column.status', width: '9%', align: 'left' },
  { key: 'progress', sortKey: 'progress', labelKey: 'column.progress', width: '10.5%', align: 'left' },
  { key: 'down', sortKey: 'downSpeed', labelKey: 'column.down', width: '7.5%', align: 'right' },
  { key: 'up', sortKey: 'upSpeed', labelKey: 'column.up', width: '7.5%', align: 'right' },
  { key: 'seeds', sortKey: 'seeds', labelKey: 'column.seeds', width: '6%', align: 'right' },
  { key: 'peers', sortKey: 'peers', labelKey: 'column.peers', width: '6%', align: 'right' },
  { key: 'eta', sortKey: 'eta', labelKey: 'column.eta', width: '6%', align: 'right' },
  { key: 'priority', sortKey: 'priority', labelKey: 'column.priority', width: '5%', align: 'right' },
  { key: 'label', sortKey: 'label', labelKey: 'column.label', width: '6%', align: 'left' },
];

export interface TableParts {
  table: HTMLTableElement;
  thead: HTMLTableSectionElement;
  tbody: HTMLTableSectionElement;
}

export function createTable(): TableParts {
  const colgroup = el('colgroup');
  for (const column of COLUMNS) {
    const col = document.createElement('col');
    col.style.width = column.width;
    colgroup.appendChild(col);
  }

  const thead = el('thead');
  const tbody = el('tbody');
  const table = el('table', { class: 'torrent-table' }, colgroup, thead, tbody);
  return { table, thead, tbody };
}

export function sortValue(torrent: Torrent, key: SortKey): number | string {
  switch (key) {
    case 'ordinal':
      return torrent.ordinal;
    case 'name':
      return torrent.name.toLowerCase();
    case 'size':
      return torrent.size;
    case 'status':
      return effectiveStatus(torrent);
    case 'progress':
      return torrent.progress;
    case 'downSpeed':
      return torrent.downSpeed;
    case 'upSpeed':
      return torrent.upSpeed;
    case 'seeds':
      return torrent.seeds;
    case 'peers':
      return torrent.peers;
    case 'eta':
      return torrent.etaSec ?? Number.POSITIVE_INFINITY;
    case 'priority':
      return torrent.priority;
    case 'label':
      return torrent.label.toLowerCase();
  }
}

export function sortTorrents(list: Torrent[], sort: SortState): Torrent[] {
  return [...list].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    let result: number;
    if (typeof av === 'number' && typeof bv === 'number') result = av - bv;
    else result = String(av).localeCompare(String(bv), 'en');
    if (result === 0) result = a.ordinal - b.ordinal;
    return result * sort.dir;
  });
}

export function renderHeader(
  thead: HTMLTableSectionElement,
  sort: SortState,
  onSort: (key: SortKey) => void,
): void {
  const row = el('tr');
  for (const column of COLUMNS) {
    const active = sort.key === column.sortKey;
    const th = el(
      'th',
      {
        class: `col-${column.key}${active ? ' sorted' : ''}${column.align === 'right' ? ' num' : ''}`,
        title: t(column.labelKey),
        'aria-sort': active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none',
      },
      el('span', { class: 'th-text', text: t(column.labelKey) }),
      active ? el('span', { class: 'sort-arrow', text: sort.dir === 1 ? '▲' : '▼' }) : null,
    );
    th.addEventListener('click', () => onSort(column.sortKey));
    row.appendChild(th);
  }
  clear(thead);
  thead.appendChild(row);
}

export function renderRows(
  tbody: HTMLTableSectionElement,
  rows: Torrent[],
  selection: Set<string>,
): void {
  const frag = document.createDocumentFragment();
  for (const torrent of rows) {
    frag.appendChild(buildRow(torrent, selection.has(torrent.id)));
  }
  clear(tbody);
  tbody.appendChild(frag);
}

function progressBar(progress: number): HTMLElement {
  const pct = Math.min(100, Math.max(0, progress * 100));
  return el(
    'div',
    { class: `prog${progress >= 1 ? ' complete' : ''}` },
    el('div', { class: 'prog-track' }, el('div', { class: 'prog-fill', style: `width:${pct.toFixed(2)}%` })),
    el('span', { class: 'prog-text', text: formatPercent(progress) }),
  );
}

function buildRow(torrent: Torrent, selected: boolean): HTMLTableRowElement {
  const status = effectiveStatus(torrent);
  const speedClass = (value: number): string => `num speed${value > 0 ? '' : ' zero'}`;

  return el(
    'tr',
    { class: selected ? 'selected' : '', dataset: { id: torrent.id } },
    el('td', { class: 'num ordinal' }, String(torrent.ordinal)),
    el('td', { class: 'name-cell', title: torrent.name }, el('span', { class: 'name-text', text: torrent.name })),
    el('td', { class: 'num' }, formatSize(torrent.size)),
    el('td', { class: 'status-cell' }, el('span', { class: `status st-${status}`, text: t(`status.${status}`) })),
    el('td', { class: 'progress-cell' }, progressBar(torrent.progress)),
    el('td', { class: speedClass(torrent.downSpeed) }, formatSpeed(torrent.downSpeed)),
    el('td', { class: speedClass(torrent.upSpeed) }, formatSpeed(torrent.upSpeed)),
    el('td', { class: 'num' }, `${torrent.seeds} (${torrent.seedsTotal})`),
    el('td', { class: 'num' }, `${torrent.peers} (${torrent.peersTotal})`),
    el('td', { class: `num eta${torrent.etaSec ? '' : ' zero'}` }, formatEta(torrent.etaSec)),
    el('td', { class: 'num priority' }, String(torrent.priority)),
    el('td', { class: 'label-cell', text: torrent.label }),
  );
}
