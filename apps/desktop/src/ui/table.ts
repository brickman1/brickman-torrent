// Torrent table: fixed columns, 30 px rows, click-to-sort headers.
//
// Column widths are pixels, not percentages. The user drags a divider in the
// header (μTorrent style), double-clicks it to fit the content, and the chosen
// widths are stored in the settings. The old percentages survive as the
// starting point: they are resolved against the table width on the first
// render, so the table looks the same until someone touches it.
//
// The "#" column is the queue position: rows come from the provider in queue
// order and the first row is the torrent that downloads first.

import { formatEta, formatPercent, formatSize, formatSpeed } from '../core/format';
import { effectiveStatus, type ColumnWidths, type Torrent } from '../core/types';
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
  | 'label';

export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

export interface ColumnDef {
  key: string;
  sortKey: SortKey;
  labelKey: string;
  /** Starting share: a `%` of the table width, or a fixed `px` value. */
  width: string;
  /** The user cannot drag the column narrower than this, px. */
  minWidth: number;
  align: 'left' | 'right';
}

export const COLUMNS: ColumnDef[] = [
  { key: 'ordinal', sortKey: 'ordinal', labelKey: 'column.index', width: '56px', minWidth: 44, align: 'right' },
  { key: 'name', sortKey: 'name', labelKey: 'column.name', width: '31.5%', minWidth: 120, align: 'left' },
  { key: 'size', sortKey: 'size', labelKey: 'column.size', width: '7%', minWidth: 44, align: 'right' },
  { key: 'status', sortKey: 'status', labelKey: 'column.status', width: '9%', minWidth: 70, align: 'left' },
  { key: 'progress', sortKey: 'progress', labelKey: 'column.progress', width: '10.5%', minWidth: 70, align: 'left' },
  { key: 'down', sortKey: 'downSpeed', labelKey: 'column.down', width: '7.5%', minWidth: 44, align: 'right' },
  { key: 'up', sortKey: 'upSpeed', labelKey: 'column.up', width: '7.5%', minWidth: 44, align: 'right' },
  { key: 'seeds', sortKey: 'seeds', labelKey: 'column.seeds', width: '6%', minWidth: 44, align: 'right' },
  { key: 'peers', sortKey: 'peers', labelKey: 'column.peers', width: '6%', minWidth: 44, align: 'right' },
  { key: 'eta', sortKey: 'eta', labelKey: 'column.eta', width: '6%', minWidth: 44, align: 'right' },
  { key: 'label', sortKey: 'label', labelKey: 'column.label', width: '6%', minWidth: 44, align: 'left' },
];

/** Table width assumed before the table is in the DOM and can be measured. */
const FALLBACK_TABLE_WIDTH = 900;
/** Long enough to swallow the click a pointerup produces after a drag. */
const SORT_SUPPRESS_MS = 300;

function parseWidth(width: string): { percent: number | null; px: number | null } {
  const value = Number.parseFloat(width);
  if (width.trim().endsWith('%')) return { percent: Number.isFinite(value) ? value : 0, px: null };
  return { percent: null, px: Number.isFinite(value) ? value : 0 };
}

const FIXED_TOTAL = COLUMNS.reduce((sum, column) => sum + (parseWidth(column.width).px ?? 0), 0);
const PERCENT_TOTAL = COLUMNS.reduce((sum, column) => sum + (parseWidth(column.width).percent ?? 0), 0);

/**
 * Default pixel widths for a table `avail` px wide: the percentage columns
 * share what the fixed ones leave, so the sum starts at exactly `avail`.
 */
export function defaultColumnWidths(avail: number): ColumnWidths {
  const room = Math.max(0, avail - FIXED_TOTAL);
  const widths: ColumnWidths = {};
  for (const column of COLUMNS) {
    const { percent, px } = parseWidth(column.width);
    const raw = px ?? (PERCENT_TOTAL > 0 ? (room * (percent ?? 0)) / PERCENT_TOTAL : 0);
    widths[column.key] = Math.max(column.minWidth, Math.round(raw));
  }
  return widths;
}

/** Drops unknown columns and anything that cannot be a width. */
function sanitizeWidths(widths: ColumnWidths | null | undefined): ColumnWidths {
  const result: ColumnWidths = {};
  if (!widths) return result;
  for (const column of COLUMNS) {
    const value = widths[column.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    result[column.key] = Math.max(column.minWidth, Math.round(value));
  }
  return result;
}

export interface ColumnLayoutOptions {
  /** Widths from the settings; columns without an entry keep the defaults. */
  widths?: ColumnWidths | null;
  /** Called after a user change, so the app can persist the new widths. */
  onChange?: (widths: ColumnWidths) => void;
}

/**
 * Owns the `<col>` widths and the header dividers.
 *
 * Only the columns the user touched are stored; the rest keep the
 * percentage defaults and follow the window, which is what a user expects
 * from a table that was never resized.
 */
export class ColumnLayout {
  readonly cols: HTMLTableColElement[];
  private readonly table: HTMLTableElement;
  private readonly onChange?: (widths: ColumnWidths) => void;
  private stored: ColumnWidths;
  /** Pixel widths as rendered; the last column may carry the free space. */
  private applied: number[] = [];
  private observer: ResizeObserver | null = null;
  private dragEndedAt = 0;

  constructor(
    table: HTMLTableElement,
    colgroup: HTMLTableColElement,
    options: ColumnLayoutOptions = {},
  ) {
    this.table = table;
    this.onChange = options.onChange;
    this.stored = sanitizeWidths(options.widths);
    this.cols = COLUMNS.map(() => {
      const col = document.createElement('col');
      colgroup.appendChild(col);
      return col;
    });
    this.apply();
  }

  /** Fills in the defaults, then writes the pixel widths to the `<col>`s. */
  apply(): void {
    const avail = this.availableWidth();
    const widths = this.resolve(avail);
    const sum = widths.reduce((total, width) => total + width, 0);
    // Free space goes to the last column: the table never leaves a gap wider
    // than the scrollbar-less container and never jumps while dragging.
    if (sum < avail) widths[widths.length - 1] += avail - sum;
    const total = Math.max(sum, avail);
    widths.forEach((width, index) => {
      this.cols[index].style.width = `${width}px`;
    });
    this.table.style.width = `${total}px`;
    this.applied = widths;
  }

  /** Follows the container width; call once the table is in the DOM. */
  observe(): void {
    const host = this.table.parentElement;
    if (!host || this.observer) return;
    this.observer = new ResizeObserver(() => this.apply());
    this.observer.observe(host);
    this.apply();
  }

  /** Stops following the container: the table is being rebuilt. */
  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Back to the default shares; the caller persists the empty object. */
  reset(): void {
    this.stored = {};
    this.apply();
    this.emitChange();
  }

  /** Fits one column to the widest header or cell content, min honoured. */
  autoFit(index: number): void {
    const column = COLUMNS[index];
    if (!column) return;
    const natural = this.measureContentWidths()[index];
    if (!Number.isFinite(natural)) return;
    this.stored[column.key] = Math.max(column.minWidth, Math.ceil(natural));
    this.apply();
    this.emitChange();
  }

  /** Drags the divider at the right edge of column `index`. */
  beginDrag(index: number, event: PointerEvent): void {
    const column = COLUMNS[index];
    if (!column) return;
    this.apply();
    const startX = event.clientX;
    const startApplied = this.applied[index] ?? column.minWidth;
    const startStored = this.resolve(this.availableWidth())[index] ?? startApplied;
    let moved = false;

    const onMove = (move: PointerEvent): void => {
      const delta = move.clientX - startX;
      if (delta !== 0) moved = true;
      // The visible width follows the pointer; the stored width is shifted by
      // the same amount, so the stretch of the last column is not "eaten".
      const applied = Math.max(column.minWidth, Math.round(startApplied + delta));
      const stored = Math.max(column.minWidth, Math.round(startStored + applied - startApplied));
      this.stored[column.key] = stored;
      this.apply();
    };

    const onEnd = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
      document.body.classList.remove('col-resizing');
      if (!moved) return;
      // The click that a pointerup produces must not sort the table.
      this.dragEndedAt = Date.now();
      this.emitChange();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onEnd);
    document.body.classList.add('col-resizing');
  }

  /** True right after a drag, so the header click does not sort. */
  sortBlocked(): boolean {
    return Date.now() - this.dragEndedAt < SORT_SUPPRESS_MS;
  }

  private emitChange(): void {
    this.onChange?.({ ...this.stored });
  }

  private resolve(avail: number): number[] {
    const defaults = defaultColumnWidths(avail);
    return COLUMNS.map((column) => this.stored[column.key] ?? defaults[column.key] ?? column.minWidth);
  }

  private availableWidth(): number {
    const host = this.table.parentElement;
    const avail = host ? host.clientWidth : 0;
    // Before the table is in the DOM there is nothing to measure; `observe()`
    // fixes the widths as soon as it is mounted.
    return avail > 0 ? avail : FALLBACK_TABLE_WIDTH;
  }

  /**
   * Natural width of every column: the table is switched to `table-layout:
   * auto` for one synchronous measurement, then put back. 15 rows, so this is
   * cheap.
   */
  private measureContentWidths(): number[] {
    const savedWidths = this.cols.map((col) => col.style.width);
    const savedLayout = this.table.style.tableLayout;
    const savedTableWidth = this.table.style.width;
    for (const col of this.cols) col.style.width = '';
    this.table.style.tableLayout = 'auto';
    this.table.style.width = 'auto';

    const widths = COLUMNS.map(() => 0);
    for (const row of Array.from(this.table.rows)) {
      for (let index = 0; index < COLUMNS.length; index += 1) {
        const cell = row.cells[index];
        if (!cell) continue;
        widths[index] = Math.max(widths[index], cell.getBoundingClientRect().width);
      }
    }

    this.cols.forEach((col, index) => {
      col.style.width = savedWidths[index];
    });
    this.table.style.tableLayout = savedLayout;
    this.table.style.width = savedTableWidth;
    return widths;
  }
}

export interface TableParts {
  table: HTMLTableElement;
  thead: HTMLTableSectionElement;
  tbody: HTMLTableSectionElement;
  layout: ColumnLayout;
}

export function createTable(options: ColumnLayoutOptions = {}): TableParts {
  const colgroup = el('colgroup');
  const thead = el('thead');
  const tbody = el('tbody');
  const table = el('table', { class: 'torrent-table' }, colgroup, thead, tbody);
  const layout = new ColumnLayout(table, colgroup, options);
  return { table, thead, tbody, layout };
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

/** The grab zone on the right edge of a header cell. */
function buildResizer(index: number, layout: ColumnLayout): HTMLElement {
  const grip = el('span', {
    class: 'col-resizer',
    'aria-hidden': 'true',
    'data-column': COLUMNS[index].key,
  });
  // The divider is a drag handle, never a sort target.
  grip.addEventListener('click', (event) => event.stopPropagation());
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    layout.beginDrag(index, event);
  });
  grip.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    layout.autoFit(index);
  });
  return grip;
}

export function renderHeader(
  thead: HTMLTableSectionElement,
  sort: SortState,
  onSort: (key: SortKey) => void,
  layout?: ColumnLayout,
): void {
  const row = el('tr');
  COLUMNS.forEach((column, index) => {
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
    th.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.col-resizer')) return;
      if (layout?.sortBlocked()) return;
      onSort(column.sortKey);
    });
    if (layout) th.appendChild(buildResizer(index, layout));
    row.appendChild(th);
  });
  clear(thead);
  thead.appendChild(row);
}

export interface RowOptions {
  /**
   * True when the table is sorted by "#" ascending, i.e. it shows the queue in
   * order. Only then can rows be dragged to reorder it.
   */
  draggable: boolean;
  /** Torrent downloading at the top of the queue: gets the accent marker. */
  activeTopId: string | null;
}

export function renderRows(
  tbody: HTMLTableSectionElement,
  rows: Torrent[],
  selection: Set<string>,
  options: RowOptions,
): void {
  const frag = document.createDocumentFragment();
  for (const torrent of rows) {
    frag.appendChild(buildRow(torrent, selection.has(torrent.id), options));
  }
  clear(tbody);
  tbody.appendChild(frag);
}

function progressBar(progress: number, status: string): HTMLElement {
  const pct = Math.min(100, Math.max(0, progress * 100));
  return el(
    'div',
    { class: `prog prog-${status}${progress >= 1 ? ' complete' : ''}` },
    el('div', { class: 'prog-track' }, el('div', { class: 'prog-fill', style: `width:${pct.toFixed(2)}%` })),
    el('span', { class: 'prog-text', text: formatPercent(progress) }),
  );
}

function ordinalCell(torrent: Torrent, activeTop: boolean): HTMLTableCellElement {
  return el(
    'td',
    {
      class: `num ordinal${activeTop ? ' top' : ''}`,
      title: activeTop ? t('table.topOfQueue') : t('table.queuePosition', { position: torrent.ordinal }),
    },
    el('span', { class: 'queue-grip', 'aria-hidden': 'true', text: '≡' }),
    activeTop ? el('span', { class: 'queue-marker', 'aria-hidden': 'true', text: '▶' }) : null,
    el('span', { class: 'ordinal-number', text: String(torrent.ordinal) }),
  );
}

function buildRow(torrent: Torrent, selected: boolean, options: RowOptions): HTMLTableRowElement {
  const status = effectiveStatus(torrent);
  const speedClass = (value: number): string => `num speed${value > 0 ? '' : ' zero'}`;
  // Swarm health is colour only; the counts stay next to the dot and the title
  // spells them out, so the colour never carries the meaning alone.
  const health = torrent.seeds >= 10 ? 'good' : torrent.seeds >= 1 ? 'warn' : 'bad';
  const row = el(
    'tr',
    {
      class: selected ? 'selected' : '',
      dataset: { id: torrent.id },
      draggable: options.draggable ? 'true' : null,
    },
    ordinalCell(torrent, options.activeTopId === torrent.id),
    el('td', { class: 'name-cell', title: torrent.name }, el('span', { class: 'name-text', text: torrent.name })),
    el('td', { class: 'num' }, formatSize(torrent.size)),
    el('td', { class: 'status-cell' }, el('span', { class: `status st-${status}`, text: t(`status.${status}`) })),
    el('td', { class: 'progress-cell' }, progressBar(torrent.progress, status)),
    el('td', { class: speedClass(torrent.downSpeed) }, formatSpeed(torrent.downSpeed)),
    el('td', { class: speedClass(torrent.upSpeed) }, formatSpeed(torrent.upSpeed)),
    el(
      'td',
      { class: 'num seeds-cell' },
      el('span', {
        class: `health-dot ${health}`,
        title: `${t('column.seeds')}: ${torrent.seeds} (${torrent.seedsTotal})`,
      }),
      `${torrent.seeds} (${torrent.seedsTotal})`,
    ),
    el('td', { class: 'num' }, `${torrent.peers} (${torrent.peersTotal})`),
    el('td', { class: `num eta${torrent.etaSec ? '' : ' zero'}` }, formatEta(torrent.etaSec)),
    el('td', { class: 'label-cell', text: torrent.label }),
  );
  return row;
}
