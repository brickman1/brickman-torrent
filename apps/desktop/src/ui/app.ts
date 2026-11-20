// Application shell and state. Plain TypeScript, no framework.

import { formatSpeed } from '../core/format';
import type { TorrentProvider } from '../core/provider';
import { applyTheme, saveSettings } from '../core/settings';
import {
  effectiveStatus,
  type AppSettings,
  type FilePriority,
  type PeerInfo,
  type SessionStats,
  type Torrent,
  type TorrentFile,
  type TrackerInfo,
  type UpdateInfo,
} from '../core/types';
import { APP_VERSION } from '../core/version';
import { getLocale, setLocale, t } from '../i18n';
import { renderDetails as renderDetailsPanel, type DetailTab } from './details';
import { clear, el } from './dom';
import { icon, type IconName } from './icons';
import { showContextMenu, type MenuItem } from './menu';
import { openModal } from './modal';
import { buildSettingsForm } from './settings-dialog';
import { COLUMNS, createTable, renderHeader, renderRows, sortTorrents, type SortKey, type SortState } from './table';

type FilterKind =
  | 'all'
  | 'downloading'
  | 'active'
  | 'queued'
  | 'completed'
  | 'paused'
  | 'stopped';

interface Filter {
  kind: FilterKind | 'label';
  label?: string;
}

interface FilterDef {
  kind: FilterKind;
  labelKey: string;
  match: (torrent: Torrent) => boolean;
}

const FILTERS: FilterDef[] = [
  { kind: 'all', labelKey: 'sidebar.all', match: () => true },
  {
    kind: 'downloading',
    labelKey: 'sidebar.downloading',
    match: (torrent) => effectiveStatus(torrent) === 'downloading',
  },
  {
    kind: 'active',
    labelKey: 'sidebar.active',
    match: (torrent) => {
      const status = effectiveStatus(torrent);
      return status === 'downloading' || status === 'seeding';
    },
  },
  { kind: 'queued', labelKey: 'sidebar.queued', match: (torrent) => torrent.queued },
  { kind: 'completed', labelKey: 'sidebar.completed', match: (torrent) => torrent.progress >= 0.999 },
  { kind: 'paused', labelKey: 'sidebar.paused', match: (torrent) => torrent.status === 'paused' },
  { kind: 'stopped', labelKey: 'sidebar.stopped', match: (torrent) => torrent.status === 'stopped' },
];

const UPDATE_CHECK_ON_START_DELAY = 1200;

interface DomRefs {
  toolbar: HTMLElement;
  sidebar: HTMLElement;
  thead: HTMLTableSectionElement;
  tbody: HTMLTableSectionElement;
  details: HTMLElement;
  statusbar: HTMLElement;
  buttons: Record<string, HTMLButtonElement>;
}

interface AppState {
  torrents: Torrent[];
  stats: SessionStats | null;
  selection: Set<string>;
  anchorId: string | null;
  filter: Filter;
  sort: SortState;
  tab: DetailTab;
}

export class App {
  private readonly root: HTMLElement;
  private readonly provider: TorrentProvider;
  private settings: AppSettings;

  private state: AppState = {
    torrents: [],
    stats: null,
    selection: new Set<string>(),
    anchorId: null,
    filter: { kind: 'all' },
    // The queue is the order: "#" ascending shows it as it downloads.
    sort: { key: 'ordinal', dir: 1 },
    tab: 'general',
  };

  private dom!: DomRefs;
  private headerSig = '';
  private detailId: string | null = null;
  private files: TorrentFile[] = [];
  private trackers: TrackerInfo[] = [];
  private peers: PeerInfo[] = [];
  private pollHandle: number | null = null;

  private updateState: 'idle' | 'checking' | 'available' | 'uptodate' = 'idle';
  private updateInfo: UpdateInfo | null = null;
  private notice: { text: string; until: number } | null = null;

  constructor(root: HTMLElement, provider: TorrentProvider, settings: AppSettings) {
    this.root = root;
    this.provider = provider;
    this.settings = settings;
  }

  async init(): Promise<void> {
    applyTheme(this.settings.theme);
    setLocale(this.settings.locale);
    this.provider.connect?.();

    await Promise.all([
      this.provider.setMaxActive(this.settings.maxActive),
      this.provider.setLimits({
        downLimit: this.settings.downLimit,
        upLimit: this.settings.upLimit,
      }),
      this.provider.setDownloadDir?.(this.settings.downloadDir),
    ]);

    this.buildShell();
    await this.refresh();

    this.pollHandle = window.setInterval(() => {
      void this.refresh();
    }, 1000);

    document.addEventListener('keydown', (event) => this.onKeyDown(event));

    window.addEventListener('beforeunload', () => {
      this.provider.disconnect?.();
      if (this.pollHandle !== null) window.clearInterval(this.pollHandle);
    });

    if (this.settings.checkUpdatesOnStartup) {
      window.setTimeout(() => {
        void this.runUpdateCheck(true);
      }, UPDATE_CHECK_ON_START_DELAY);
    }
  }

  // ------------------------------------------------------------------ shell

  private buildShell(): void {
    clear(this.root);

    const toolbar = el('header', { class: 'toolbar' });
    const buttons: Record<string, HTMLButtonElement> = {};

    const addButton = (
      id: string,
      iconName: IconName,
      titleKey: string,
      onClick: () => void,
    ): HTMLButtonElement => {
      const button = el(
        'button',
        { class: 'tb-btn', type: 'button', title: t(titleKey), 'aria-label': t(titleKey) },
        icon(iconName),
      );
      button.addEventListener('click', onClick);
      buttons[id] = button;
      return button;
    };

    const separator = (): HTMLElement => el('div', { class: 'tb-sep' });

    const localeSelect = el(
      'select',
      { class: 'tb-select', title: t('toolbar.language'), 'aria-label': t('toolbar.language') },
      el('option', { value: 'en' }, 'EN'),
      el('option', { value: 'ru' }, 'RU'),
    );
    localeSelect.value = this.settings.locale;
    localeSelect.addEventListener('change', () => {
      this.changeLocale(localeSelect.value === 'ru' ? 'ru' : 'en');
    });

    const themeButton = addButton('theme', 'moon', 'toolbar.darkTheme', () => this.toggleTheme());

    const updateButton = addButton('updates', 'refresh', 'toolbar.checkUpdates', () => {
      void this.runUpdateCheck(false);
    });
    updateButton.appendChild(el('span', { class: 'tb-badge' }));

    const left = el(
      'div',
      { class: 'tb-group' },
      addButton('add-file', 'addFile', 'toolbar.addFile', () => void this.addTorrentFile()),
      addButton('add-magnet', 'addLink', 'toolbar.addMagnet', () => this.openAddMagnet()),
      separator(),
      addButton('start', 'start', 'toolbar.start', () => void this.applySelectionAction('start')),
      addButton('pause', 'pause', 'toolbar.pause', () => void this.applySelectionAction('pause')),
      addButton('stop', 'stop', 'toolbar.stop', () => void this.applySelectionAction('stop')),
      separator(),
      addButton('remove', 'remove', 'toolbar.remove', () => this.confirmRemove([...this.state.selection])),
      separator(),
      addButton('settings', 'settings', 'toolbar.settings', () => this.openSettings()),
    );

    const right = el(
      'div',
      { class: 'tb-group tb-right' },
      localeSelect,
      themeButton,
      updateButton,
    );

    toolbar.append(left, el('div', { class: 'tb-spacer' }), right);

    const sidebar = el('aside', { class: 'sidebar' });
    const { table, thead, tbody } = createTable();
    const tableWrap = el('div', { class: 'table-wrap' }, table);
    const main = el('div', { class: 'main' }, sidebar, tableWrap);
    const details = el('section', { class: 'details' });
    const statusbar = el('footer', { class: 'statusbar' });
    const shell = el('div', { class: 'shell' }, toolbar, main, details, statusbar);

    this.root.appendChild(shell);

    this.dom = { toolbar, sidebar, thead, tbody, details, statusbar, buttons };
    this.headerSig = '';

    tbody.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
      if (!row?.dataset.id) return;
      this.selectRow(row.dataset.id, event);
    });

    tbody.addEventListener('dblclick', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
      if (!row?.dataset.id) return;
      this.state.tab = 'files';
      void this.loadDetails(true).then(() => this.render(true));
    });

    tbody.addEventListener('contextmenu', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
      if (!row?.dataset.id) return;
      event.preventDefault();
      this.openRowMenu(row.dataset.id, event.clientX, event.clientY);
    });

    this.attachRowDragAndDrop();

    this.updateThemeButton();
    this.updateUpdateButton();
  }

  // ------------------------------------------------------------------- drag

  /**
   * Drag a row to a new place in the queue. Enabled only while the table is
   * sorted by "#" ascending, because only then the row order is the queue:
   * a name/size sort is a temporary view and is not allowed to rewrite it.
   */
  private attachRowDragAndDrop(): void {
    const tbody = this.dom.tbody;
    let dragId: string | null = null;

    const clearMarks = (): void => {
      for (const marked of tbody.querySelectorAll('tr.drop-before, tr.drop-after, tr.dragging')) {
        marked.classList.remove('drop-before', 'drop-after', 'dragging');
      }
    };

    tbody.addEventListener('dragstart', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
      if (!row?.dataset.id) return;
      if (!this.queueEditable()) {
        // Explain instead of silently doing nothing.
        event.preventDefault();
        this.toast(t('toast.sortToReorder'));
        return;
      }
      dragId = row.dataset.id;
      event.dataTransfer?.setData('text/plain', dragId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });

    tbody.addEventListener('dragover', (event) => {
      if (!dragId) return;
      const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
      if (!row || row.dataset.id === dragId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      for (const marked of tbody.querySelectorAll('tr.drop-before, tr.drop-after')) {
        marked.classList.remove('drop-before', 'drop-after');
      }
      row.classList.add(after ? 'drop-after' : 'drop-before');
    });

    tbody.addEventListener('dragleave', (event) => {
      if (event.target === tbody) clearMarks();
    });

    tbody.addEventListener('drop', (event) => {
      const moved = dragId;
      dragId = null;
      clearMarks();
      if (!moved) return;
      const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
      const target = row ? this.state.torrents.find((torrent) => torrent.id === row.dataset.id) : undefined;
      if (!target) return;
      event.preventDefault();
      const rect = row!.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      // `ordinal` is the 1-based queue position, so the zero-based insertion
      // index is `ordinal - 1` before the row and `ordinal` after it.
      const index = Math.max(0, after ? target.ordinal : target.ordinal - 1);
      void this.moveTo(moved, index);
    });

    tbody.addEventListener('dragend', () => {
      dragId = null;
      clearMarks();
    });
  }

  /** Row order equals the queue only when sorted by "#" ascending. */
  private queueEditable(): boolean {
    return this.state.sort.key === 'ordinal' && this.state.sort.dir === 1;
  }

  // ------------------------------------------------------------- data flow

  private async refresh(forceDetails = false): Promise<void> {
    try {
      const [torrents, stats] = await Promise.all([this.provider.list(), this.provider.stats()]);
      this.state.torrents = torrents;
      this.state.stats = stats;

      const known = new Set(torrents.map((torrent) => torrent.id));
      for (const id of [...this.state.selection]) {
        if (!known.has(id)) this.state.selection.delete(id);
      }
      if (this.state.anchorId && !known.has(this.state.anchorId)) this.state.anchorId = null;

      if (this.state.filter.kind === 'label') {
        const labels = new Set(torrents.map((torrent) => torrent.label));
        if (!labels.has(this.state.filter.label ?? '')) {
          this.state.filter = { kind: 'all' };
        }
      }

      await this.loadDetails(forceDetails);
      this.render();
    } catch (err) {
      console.error('[brickman-torrent] refresh failed', err);
    }
  }

  private async loadDetails(force = false): Promise<void> {
    const id = this.primaryId();
    if (!id) {
      this.detailId = null;
      this.files = [];
      this.trackers = [];
      this.peers = [];
      return;
    }

    if (force || id !== this.detailId) {
      this.detailId = id;
      const [files, trackers, peers] = await Promise.all([
        this.provider.files(id),
        this.provider.trackers(id),
        this.provider.peers(id),
      ]);
      this.files = files;
      this.trackers = trackers;
      this.peers = peers;
      return;
    }

    // Only the visible tab is refreshed on the 1 s poll.
    if (this.state.tab === 'files') this.files = await this.provider.files(id);
  }

  // ----------------------------------------------------------------- render

  private render(forceDetails = false): void {
    this.renderSidebar();
    this.renderTable();
    this.renderDetails(forceDetails);
    this.renderStatusbar();
    this.updateToolbarState();
  }

  private visibleTorrents(): Torrent[] {
    return sortTorrents(
      this.state.torrents.filter((torrent) => this.matchesFilter(torrent)),
      this.state.sort,
    );
  }

  private matchesFilter(torrent: Torrent): boolean {
    const filter = this.state.filter;
    if (filter.kind === 'all') return true;
    if (filter.kind === 'label') return torrent.label === filter.label;
    const def = FILTERS.find((item) => item.kind === filter.kind);
    return def ? def.match(torrent) : true;
  }

  private renderSidebar(): void {
    const container = this.dom.sidebar;
    clear(container);

    const counts = new Map<FilterKind, number>();
    for (const filter of FILTERS) {
      counts.set(filter.kind, this.state.torrents.filter((torrent) => filter.match(torrent)).length);
    }

    const list = el('div', { class: 'side-list' });
    for (const filter of FILTERS) {
      const active = this.state.filter.kind === filter.kind;
      const button = el(
        'button',
        { class: `side-item${active ? ' active' : ''}`, type: 'button' },
        el('span', { class: 'side-label', text: t(filter.labelKey) }),
        el('span', { class: 'side-count', text: String(counts.get(filter.kind) ?? 0) }),
      );
      button.addEventListener('click', () => this.setFilter({ kind: filter.kind }));
      list.appendChild(button);
    }
    container.appendChild(list);

    const labelCounts = new Map<string, number>();
    for (const torrent of this.state.torrents) {
      if (!torrent.label) continue;
      labelCounts.set(torrent.label, (labelCounts.get(torrent.label) ?? 0) + 1);
    }
    const labels = [...labelCounts.keys()].sort((a, b) => a.localeCompare(b));

    container.appendChild(
      el('div', { class: 'side-header' }, icon('tag'), el('span', { text: t('sidebar.labels') })),
    );

    const labelList = el('div', { class: 'side-list labels' });
    for (const label of labels) {
      const active = this.state.filter.kind === 'label' && this.state.filter.label === label;
      const button = el(
        'button',
        { class: `side-item label${active ? ' active' : ''}`, type: 'button' },
        el('span', { class: 'label-dot' }),
        el('span', { class: 'side-label', text: label }),
        el('span', { class: 'side-count', text: String(labelCounts.get(label) ?? 0) }),
      );
      button.addEventListener('click', () => this.setFilter({ kind: 'label', label }));
      labelList.appendChild(button);
    }
    container.appendChild(labelList);
  }

  private renderTable(): void {
    const signature = `${this.state.sort.key}:${this.state.sort.dir}`;
    if (signature !== this.headerSig) {
      renderHeader(this.dom.thead, this.state.sort, (key) => this.toggleSort(key));
      this.headerSig = signature;
    }

    const rows = this.visibleTorrents();
    if (rows.length === 0) {
      clear(this.dom.tbody);
      this.dom.tbody.appendChild(
        el(
          'tr',
          { class: 'empty-row' },
          el('td', { colspan: COLUMNS.length, text: t('table.empty') }),
        ),
      );
      return;
    }
    // The torrent that actually downloads at the top of the queue gets the
    // accent in the "#" column.
    const activeTop = this.state.torrents
      .filter((torrent) => effectiveStatus(torrent) === 'downloading')
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    renderRows(this.dom.tbody, rows, this.state.selection, {
      draggable: this.queueEditable(),
      activeTopId: activeTop ? activeTop.id : null,
    });
  }

  private renderDetails(force: boolean): void {
    if (!force && this.isDetailsBusy()) return;

    renderDetailsPanel(this.dom.details, {
      torrent: this.selectedTorrent(),
      tab: this.state.tab,
      files: this.files,
      trackers: this.trackers,
      peers: this.peers,
      onTab: (tab) => {
        this.state.tab = tab;
        void this.loadDetails(true).then(() => this.render(true));
      },
      onFilePriority: (fileId, priority) => {
        const id = this.primaryId();
        if (!id) return;
        void this.provider
          .setFilePriority(id, fileId, priority)
          .then(() => this.loadDetails(true))
          .then(() => this.render(true));
      },
      onAllFiles: (priority) => {
        void this.setAllFilePriorities(priority);
      },
    });
  }

  private renderStatusbar(): void {
    const container = this.dom.statusbar;
    clear(container);
    if (this.notice && Date.now() > this.notice.until) this.notice = null;

    const stats = this.state.stats;
    const downSpeed = stats?.downSpeed ?? 0;
    const upSpeed = stats?.upSpeed ?? 0;

    const left = el(
      'div',
      { class: 'sb-group' },
      this.sbItem('↓', formatSpeed(downSpeed), `${t('statusbar.down')}: ${formatSpeed(downSpeed)}`),
      this.sbItem('↑', formatSpeed(upSpeed), `${t('statusbar.up')}: ${formatSpeed(upSpeed)}`),
      this.sbItem(
        t('statusbar.activeLabel'),
        String(stats?.active ?? 0),
        t('statusbar.activeHint'),
      ),
    );

    const portOpen = stats?.portOpen ?? false;
    left.appendChild(
      el(
        'span',
        { class: 'sb-item', title: t('statusbar.portHint', { port: stats?.port ?? 0 }) },
        el('span', { class: `sb-dot ${portOpen ? 'ok' : 'err'}` }),
        el('span', { text: t(portOpen ? 'statusbar.portOpen' : 'statusbar.portClosed') }),
      ),
    );

    if (this.updateState === 'checking') {
      left.appendChild(
        el('span', { class: 'sb-item sb-notice', text: t('update.checking') }),
      );
    } else if (this.updateState === 'available' && this.updateInfo?.version) {
      const button = el(
        'button',
        {
          class: 'sb-item sb-update',
          type: 'button',
          title: t('update.availableShort', { version: this.updateInfo.version }),
        },
        el('span', { class: 'sb-dot warn' }),
        el('span', { text: t('update.availableShort', { version: this.updateInfo.version }) }),
      );
      button.addEventListener('click', () => this.openUpdateDialog());
      left.appendChild(button);
    } else if (this.notice) {
      left.appendChild(el('span', { class: 'sb-item sb-notice', text: this.notice.text }));
    }

    const right = el(
      'div',
      { class: 'sb-group right' },
      this.provider.kind === 'mock' ? el('span', { class: 'sb-badge', text: t('statusbar.mock') }) : null,
      el('span', { class: 'sb-item', text: `v${APP_VERSION}` }),
    );

    container.append(left, right);
  }

  private sbItem(key: string, value: string, title: string): HTMLElement {
    return el(
      'span',
      { class: 'sb-item', title },
      el('span', { class: 'sb-key', text: key }),
      el('span', { text: value }),
    );
  }

  private updateToolbarState(): void {
    const hasSelection = this.state.selection.size > 0;
    for (const id of ['start', 'pause', 'stop', 'remove']) {
      const button = this.dom.buttons[id];
      if (button) button.disabled = !hasSelection;
    }
    this.updateUpdateButton();
  }

  private updateUpdateButton(): void {
    const button = this.dom.buttons.updates;
    if (!button) return;
    const available = this.updateState === 'available' && this.updateInfo?.version;
    button.classList.toggle('has-update', Boolean(available));
    button.title = available
      ? t('update.availableShort', { version: this.updateInfo?.version ?? '' })
      : t('toolbar.checkUpdates');
  }

  private updateThemeButton(): void {
    const button = this.dom.buttons.theme;
    if (!button) return;
    clear(button);
    button.appendChild(icon(this.settings.theme === 'light' ? 'moon' : 'sun'));
    button.title = t(this.settings.theme === 'light' ? 'toolbar.darkTheme' : 'toolbar.lightTheme');
    button.setAttribute('aria-label', button.title);
  }

  // ------------------------------------------------------------- selection

  private primaryId(): string | null {
    if (this.state.anchorId && this.state.selection.has(this.state.anchorId)) {
      return this.state.anchorId;
    }
    const first = this.state.selection.values().next();
    return first.done ? null : first.value;
  }

  private selectedTorrent(): Torrent | null {
    const id = this.primaryId();
    return id ? this.state.torrents.find((torrent) => torrent.id === id) ?? null : null;
  }

  private selectRow(id: string, event: MouseEvent): void {
    const rows = this.visibleTorrents();
    const anchorIndex = this.state.anchorId
      ? rows.findIndex((torrent) => torrent.id === this.state.anchorId)
      : -1;
    const targetIndex = rows.findIndex((torrent) => torrent.id === id);

    if (event.shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
      if (!(event.ctrlKey || event.metaKey)) this.state.selection.clear();
      const from = Math.min(anchorIndex, targetIndex);
      const to = Math.max(anchorIndex, targetIndex);
      for (let i = from; i <= to; i += 1) {
        const row = rows[i];
        if (row) this.state.selection.add(row.id);
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (this.state.selection.has(id)) this.state.selection.delete(id);
      else this.state.selection.add(id);
      this.state.anchorId = id;
    } else {
      this.state.selection = new Set([id]);
      this.state.anchorId = id;
    }

    void this.loadDetails(true).then(() => this.render());
  }

  private setFilter(filter: Filter): void {
    this.state.filter = filter;
    this.state.selection.clear();
    this.state.anchorId = null;
    this.detailId = null;
    this.files = [];
    this.trackers = [];
    this.peers = [];
    this.render(true);
  }

  private toggleSort(key: SortKey): void {
    if (this.state.sort.key === key) {
      this.state.sort = { key, dir: this.state.sort.dir === 1 ? -1 : 1 };
    } else {
      this.state.sort = { key, dir: 1 };
    }
    this.render();
  }

  // --------------------------------------------------------------- actions

  private isDetailsBusy(): boolean {
    const active = document.activeElement;
    return (
      active instanceof HTMLElement &&
      this.dom.details.contains(active) &&
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)
    );
  }

  private async applySelectionAction(action: 'start' | 'pause' | 'stop'): Promise<void> {
    const ids = [...this.state.selection];
    if (ids.length === 0) {
      this.toast(t('toast.noSelection'));
      return;
    }
    await this.provider[action](ids);
    await this.refresh();
  }

  /**
   * Reorders the queue: `index` is a zero-based position (drag and drop, or
   * "move to position" with the number converted by the caller). The core
   * applies the new order at once, so a different torrent may start now.
   */
  private async moveTo(id: string, index: number): Promise<void> {
    await this.provider.moveTo(id, index);
    await this.refresh();
  }

  private async moveBy(id: string, delta: -1 | 1): Promise<void> {
    await this.provider.moveBy(id, delta);
    await this.refresh();
  }

  private async setAllFilePriorities(priority: FilePriority): Promise<void> {
    const id = this.primaryId();
    if (!id) return;
    for (const file of this.files) {
      await this.provider.setFilePriority(id, file.id, priority);
    }
    this.files = await this.provider.files(id);
    this.render(true);
  }

  private async removeTorrents(ids: string[], deleteData: boolean): Promise<void> {
    if (ids.length === 0) return;
    await this.provider.remove(ids, deleteData);
    for (const id of ids) this.state.selection.delete(id);
    this.state.anchorId = null;
    this.detailId = null;
    this.toast(t('toast.removed', { count: ids.length }));
    await this.refresh();
  }

  private async addTorrentFile(): Promise<void> {
    try {
      const torrent = await this.provider.addFile();
      this.state.selection = new Set([torrent.id]);
      this.state.anchorId = torrent.id;
      this.state.filter = { kind: 'all' };
      this.toast(t('toast.added', { name: torrent.name }));
      await this.refresh(true);
    } catch (err) {
      console.error(err);
      this.toast(t('toast.error'));
    }
  }

  private openAddMagnet(): void {
    const input = el('input', {
      class: 'text-input',
      type: 'text',
      placeholder: t('dialog.magnetPlaceholder'),
      value: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Sintel.2010.2160p.mkv',
    });

    openModal({
      title: t('dialog.magnetTitle'),
      width: 520,
      body: el(
        'div',
        { class: 'form' },
        el(
          'label',
          { class: 'field' },
          el('span', { class: 'field-label', text: t('dialog.magnetLabel') }),
          input,
        ),
        el('p', { class: 'hint', text: t('dialog.magnetHint') }),
      ),
      buttons: [
        { label: t('common.cancel') },
        {
          label: t('common.add'),
          primary: true,
          onClick: () => {
            void this.addMagnet(input.value);
          },
        },
      ],
    });
  }

  private async addMagnet(uri: string): Promise<void> {
    try {
      const torrent = await this.provider.addMagnet(uri);
      this.state.selection = new Set([torrent.id]);
      this.state.anchorId = torrent.id;
      this.state.filter = { kind: 'all' };
      this.toast(t('toast.added', { name: torrent.name }));
      await this.refresh(true);
    } catch (err) {
      console.error(err);
      this.toast(t('toast.error'));
    }
  }

  private confirmRemove(ids: string[]): void {
    if (ids.length === 0) {
      this.toast(t('toast.noSelection'));
      return;
    }

    const deleteData = el('input', { type: 'checkbox' });
    openModal({
      title: t('dialog.removeTitle'),
      width: 420,
      body: el(
        'div',
        { class: 'form' },
        el('p', { class: 'dialog-text', text: t('dialog.removeBody', { count: ids.length }) }),
        el(
          'label',
          { class: 'check-row' },
          deleteData,
          el('span', { text: t('dialog.removeData') }),
        ),
      ),
      buttons: [
        { label: t('common.cancel') },
        {
          label: t('common.remove'),
          danger: true,
          onClick: () => {
            void this.removeTorrents(ids, deleteData.checked);
          },
        },
      ],
    });
  }

  /** "Move to position…": a number instead of dragging. */
  private promptQueuePosition(): void {
    const torrent = this.selectedTorrent();
    if (!torrent) {
      this.toast(t('toast.noSelection'));
      return;
    }

    const input = el('input', {
      class: 'text-input',
      type: 'number',
      min: 1,
      max: this.state.torrents.length,
      value: String(torrent.ordinal),
    });

    openModal({
      title: t('dialog.positionTitle'),
      width: 340,
      body: el(
        'div',
        { class: 'form' },
        el(
          'label',
          { class: 'field' },
          el('span', { class: 'field-label', text: t('dialog.positionLabel') }),
          input,
        ),
        el('p', { class: 'hint', text: t('dialog.positionHint') }),
      ),
      buttons: [
        { label: t('common.cancel') },
        {
          label: t('common.ok'),
          primary: true,
          onClick: () => {
            const position = Math.round(Number(input.value));
            if (!Number.isFinite(position) || position < 1) return;
            void this.moveTo(torrent.id, position - 1);
          },
        },
      ],
    });
  }

  private openRowMenu(id: string, x: number, y: number): void {
    if (!this.state.selection.has(id)) {
      this.state.selection = new Set([id]);
      this.state.anchorId = id;
      void this.loadDetails(true).then(() => this.render());
    }

    const torrent = this.state.torrents.find((item) => item.id === id);
    const position = torrent?.ordinal ?? 1;
    const last = this.state.torrents.length;
    const queueItems: MenuItem[] = [
      {
        label: t('menu.moveTop'),
        disabled: position <= 1,
        action: () => void this.moveTo(id, 0),
      },
      {
        label: t('menu.moveUp'),
        disabled: position <= 1,
        action: () => void this.moveBy(id, -1),
      },
      {
        label: t('menu.moveDown'),
        disabled: position >= last,
        action: () => void this.moveBy(id, 1),
      },
      { separator: true },
      { label: t('menu.moveToPosition'), action: () => this.promptQueuePosition() },
    ];

    showContextMenu(
      [
        { label: t('menu.start'), action: () => void this.applySelectionAction('start') },
        { label: t('menu.pause'), action: () => void this.applySelectionAction('pause') },
        { label: t('menu.stop'), action: () => void this.applySelectionAction('stop') },
        { separator: true },
        ...queueItems,
        { separator: true },
        { label: t('menu.remove'), action: () => this.confirmRemove([...this.state.selection]) },
      ],
      x,
      y,
    );
  }

  // -------------------------------------------------------------- settings

  private openSettings(): void {
    const form = buildSettingsForm(this.settings, {
      isMock: Boolean(this.provider.mockHooks),
      mockUpdateAvailable: this.provider.mockHooks?.isUpdateAvailable() ?? false,
      onMockUpdateChange: (available) => {
        this.provider.mockHooks?.setUpdateAvailable(available);
        if (!available) {
          this.updateState = 'idle';
          this.updateInfo = null;
          this.updateUpdateButton();
          this.renderStatusbar();
        }
      },
      version: APP_VERSION,
    });

    openModal({
      title: t('settings.title'),
      width: 480,
      body: form.body,
      buttons: [
        { label: t('common.cancel') },
        {
          label: t('settings.apply'),
          primary: true,
          onClick: () => {
            void this.applySettings(form.read());
          },
        },
      ],
    });
  }

  private async applySettings(next: AppSettings): Promise<void> {
    const localeChanged = next.locale !== this.settings.locale;
    const themeChanged = next.theme !== this.settings.theme;
    this.settings = next;
    saveSettings(next);

    if (themeChanged) applyTheme(next.theme);
    if (localeChanged) setLocale(next.locale);

    await Promise.all([
      this.provider.setMaxActive(next.maxActive),
      this.provider.setLimits({ downLimit: next.downLimit, upLimit: next.upLimit }),
      this.provider.setDownloadDir?.(next.downloadDir),
    ]);

    if (localeChanged) {
      this.buildShell();
      await this.refresh(true);
    } else {
      this.updateThemeButton();
      await this.refresh(true);
    }
  }

  private changeLocale(locale: AppSettings['locale']): void {
    if (locale === this.settings.locale) return;
    this.settings = { ...this.settings, locale };
    saveSettings(this.settings);
    setLocale(locale);
    this.buildShell();
    this.render(true);
    if (this.settings.locale !== getLocale()) {
      console.warn('[brickman-torrent] locale did not switch');
    }
  }

  private toggleTheme(): void {
    const theme: AppSettings['theme'] = this.settings.theme === 'light' ? 'dark' : 'light';
    this.settings = { ...this.settings, theme };
    saveSettings(this.settings);
    applyTheme(theme);
    this.updateThemeButton();
  }

  // ---------------------------------------------------------------- updates

  private async runUpdateCheck(silent: boolean): Promise<void> {
    if (this.updateState === 'checking') return;
    this.updateState = 'checking';
    this.notice = null;
    this.renderStatusbar();

    try {
      const info = await this.provider.checkForUpdates();
      this.updateInfo = info;
      if (info.available) {
        this.updateState = 'available';
        if (!silent) this.openUpdateDialog();
      } else {
        this.updateState = 'uptodate';
        const text = t('update.upToDate', { version: info.currentVersion });
        this.setNotice(text, 6000);
        if (!silent) this.toast(text);
      }
    } catch (err) {
      console.error('[brickman-torrent] update check failed', err);
      this.updateState = 'idle';
      this.toast(t('update.failed'));
    }

    this.renderStatusbar();
    this.updateUpdateButton();
  }

  private openUpdateDialog(): void {
    const info = this.updateInfo;
    if (!info || !info.available || !info.version) return;

    const changelog = el(
      'ul',
      { class: 'update-changelog' },
      ...info.changelog.map((line) => el('li', { text: t(line) })),
    );

    openModal({
      title: t('update.title'),
      width: 460,
      body: el(
        'div',
        { class: 'update-body' },
        el(
          'div',
          { class: 'update-head' },
          el('span', { class: 'update-version', text: `v${info.version}` }),
          el('span', {
            class: 'update-current',
            text: t('update.currentVersion', { version: info.currentVersion }),
          }),
        ),
        el('div', { class: 'update-section', text: t('update.changelog') }),
        changelog,
        el('div', { class: 'update-note', text: t('update.downloadHint') }),
      ),
      buttons: [
        { label: t('update.later') },
        {
          label: t('update.download'),
          primary: true,
          onClick: () => {
            if (info.url) void this.provider.openExternal(info.url);
            this.toast(t('update.downloadStub'));
          },
        },
      ],
    });
  }

  private setNotice(text: string, durationMs: number): void {
    this.notice = { text, until: Date.now() + durationMs };
    this.renderStatusbar();
  }

  private toast(text: string): void {
    const node = el('div', { class: 'toast', text });
    document.body.appendChild(node);
    window.setTimeout(() => node.classList.add('visible'), 10);
    window.setTimeout(() => {
      node.classList.remove('visible');
      window.setTimeout(() => node.remove(), 250);
    }, 3200);
  }

  // --------------------------------------------------------------- keyboard

  private onKeyDown(event: KeyboardEvent): void {
    if (document.querySelector('.modal-overlay')) return;
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.state.selection = new Set(this.visibleTorrents().map((torrent) => torrent.id));
      const first = this.visibleTorrents()[0];
      this.state.anchorId = first ? first.id : null;
      void this.loadDetails(true).then(() => this.render());
      return;
    }

    if (event.key === 'Delete') {
      event.preventDefault();
      this.confirmRemove([...this.state.selection]);
      return;
    }

    if (event.key === ' ') {
      event.preventDefault();
      const selected = this.state.torrents.filter((torrent) => this.state.selection.has(torrent.id));
      if (selected.length === 0) return;
      const allStopped = selected.every(
        (torrent) => torrent.status === 'paused' || torrent.status === 'stopped',
      );
      void this.applySelectionAction(allStopped ? 'start' : 'pause');
      return;
    }

    if (event.key === 'Escape') {
      this.state.selection.clear();
      this.state.anchorId = null;
      void this.loadDetails(true).then(() => this.render());
    }
  }
}
