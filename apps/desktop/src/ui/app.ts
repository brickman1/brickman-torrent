// Application shell and state. Plain TypeScript, no framework.

import { formatSpeed } from '../core/format';
import { notifyCompletion, setCompletionActionHandler } from '../core/notifications';
import type { TorrentProvider } from '../core/provider';
import { applyTheme, saveSettings } from '../core/settings';
import {
  effectiveStatus,
  withRecentFolder,
  type AddTorrentOptions,
  type AppSettings,
  type ColumnWidths,
  type FilePriority,
  type LinkPayload,
  type OutputDirChange,
  type PeerInfo,
  type PowerAction,
  type PowerStatus,
  type SessionStats,
  type Torrent,
  type TorrentFile,
  type TorrentPreview,
  type TrackerInfo,
  type UpdateInfo,
} from '../core/types';
import { APP_VERSION } from '../core/version';
import { getLocale, isLocale, LOCALES, LOCALE_NAMES, setLocale, t } from '../i18n';
import { openAddDialog, type AddDialogRequest } from './add-dialog';
import { openChangeFolderDialog } from './change-folder-dialog';
import { renderDetails as renderDetailsPanel, type DetailTab } from './details';
import { clear, el } from './dom';
import { attachTorrentDrop, type DroppedTorrent } from './drop-target';
import { errorText } from './folder-field';
import { icon, type IconName } from './icons';
import { showContextMenu, type MenuItem } from './menu';
import { openModal, type ModalButton } from './modal';
import { buildSettingsForm } from './settings-dialog';
import {
  COLUMNS,
  createTable,
  renderHeader,
  renderRows,
  sortTorrents,
  type ColumnLayout,
  type SortKey,
  type SortState,
} from './table';

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

/** Banner wording per action; the force variant shuts down like a normal one. */
const POWER_BANNER_KEYS: Record<PowerAction, string> = {
  nothing: 'power.banner.shutdown',
  sleep: 'power.banner.sleep',
  hibernate: 'power.banner.hibernate',
  shutdown: 'power.banner.shutdown',
  'force-shutdown': 'power.banner.shutdown',
};

interface DomRefs {
  toolbar: HTMLElement;
  sidebar: HTMLElement;
  thead: HTMLTableSectionElement;
  tbody: HTMLTableSectionElement;
  layout: ColumnLayout;
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
  /** Stops the `link-received` delivery on unload. */
  private unsubscribeLinks: (() => void) | null = null;
  /** Stops the window-wide drag and drop listeners on unload. */
  private detachDrop: (() => void) | null = null;
  /**
   * Last "100 % reached" answer per torrent, so the "download finished"
   * notification fires on the transition, not on every poll.
   */
  private readonly completedSeen = new Map<string, boolean>();

  private updateState: 'idle' | 'checking' | 'available' | 'uptodate' = 'idle';
  private updateInfo: UpdateInfo | null = null;
  /** In-app install is possible (the updater has the release signing key). */
  private updaterReady = false;
  private notice: { text: string; until: number } | null = null;
  /** "Power off when downloads finish" countdown, polled with the torrents. */
  private powerStatus: PowerStatus | null = null;
  private powerBanner: HTMLElement | null = null;
  /** System default download folder, shown when the setting is empty. */
  private systemDownloadDir = '';

  constructor(root: HTMLElement, provider: TorrentProvider, settings: AppSettings) {
    this.root = root;
    this.provider = provider;
    this.settings = settings;
  }

  async init(): Promise<void> {
    applyTheme(this.settings.theme);
    setLocale(this.settings.locale);
    this.pushCloseToTray(this.settings.closeToTray);
    this.provider.connect?.();
    this.systemDownloadDir = await this.resolveSystemDownloadDir();

    await Promise.all([
      this.provider.setMaxActive(this.settings.maxActive),
      this.provider.setLimits({
        downLimit: this.settings.downLimit,
        upLimit: this.settings.upLimit,
      }),
      this.provider.setDownloadDir?.(this.settings.downloadDir),
      this.pushPowerSettings(this.settings),
      this.pushConnectionSettings(this.settings),
    ]);

    this.buildShell();
    this.subscribeLinks();
    this.attachDropTarget();
    setCompletionActionHandler((id) => this.openTorrentFolder(id));
    await this.refresh();

    this.pollHandle = window.setInterval(() => {
      void this.refresh();
    }, 1000);

    document.addEventListener('keydown', (event) => this.onKeyDown(event));

    window.addEventListener('beforeunload', () => {
      this.provider.disconnect?.();
      this.unsubscribeLinks?.();
      this.detachDrop?.();
      setCompletionActionHandler(null);
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
    // The old table's observer would keep watching a wrapper that is gone.
    this.dom?.layout.disconnect();
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
      // Native names: the switcher is usable even if the current language is
      // not the one the user reads.
      ...LOCALES.map((locale) => el('option', { value: locale }, LOCALE_NAMES[locale])),
    );
    localeSelect.value = this.settings.locale;
    localeSelect.addEventListener('change', () => {
      if (isLocale(localeSelect.value)) this.changeLocale(localeSelect.value);
    });

    const themeButton = addButton('theme', 'moon', 'toolbar.darkTheme', () => this.toggleTheme());

    const updateButton = addButton('updates', 'refresh', 'toolbar.checkUpdates', () => {
      void this.runUpdateCheck(false);
    });
    updateButton.appendChild(el('span', { class: 'tb-badge' }));

    const left = el(
      'div',
      { class: 'tb-group' },
      addButton('add-file', 'addFile', 'toolbar.addFile', () => this.openAddTorrentFile()),
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
    const { table, thead, tbody, layout } = createTable({
      widths: this.settings.columnWidths,
      onChange: (widths) => this.saveColumnWidths(widths),
    });
    const tableWrap = el('div', { class: 'table-wrap' }, table);
    const main = el('div', { class: 'main' }, sidebar, tableWrap);
    const details = el('section', { class: 'details' });
    const statusbar = el('footer', { class: 'statusbar' });
    const shell = el('div', { class: 'shell' }, toolbar, main, details, statusbar);

    this.root.appendChild(shell);

    this.dom = { toolbar, sidebar, thead, tbody, layout, details, statusbar, buttons };
    this.headerSig = '';
    // Only now the table has a width to resolve the starting column shares.
    layout.observe();

    thead.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(
        [{ label: t('menu.resetColumnWidths'), action: () => this.resetColumnWidths() }],
        event.clientX,
        event.clientY,
      );
    });

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

  // ------------------------------------------------- window drop of a torrent

  /**
   * HTML5 drag and drop on the whole window: a `.torrent` file or a magnet link
   * dropped anywhere opens the add flow. The native Tauri drag/drop event is
   * not used, it would replace the webview handler the queue rows rely on.
   */
  private attachDropTarget(): void {
    this.detachDrop?.();
    this.detachDrop = attachTorrentDrop({
      onTorrents: (dropped) => void this.addDroppedTorrents(dropped),
      onMagnet: (uri) => void this.showAddDialog({ mode: 'magnet', uri }),
      onUnsupported: () => this.toast(t('drop.unsupported')),
    });
  }

  /**
   * A single dropped `.torrent` opens the add dialog, several are added after
   * one confirmation. The webview hides the path of a dropped file, so the
   * bytes are staged into a real file first and the usual path flow runs.
   */
  private async addDroppedTorrents(dropped: DroppedTorrent[]): Promise<void> {
    const paths: string[] = [];
    for (const entry of dropped) {
      if (entry.path) {
        paths.push(entry.path);
        continue;
      }
      const stage = this.provider.stageDroppedTorrent;
      if (!entry.bytes || !stage) continue;
      try {
        paths.push(await stage.call(this.provider, entry.name, entry.bytes));
      } catch (err) {
        this.toast(errorText(err));
      }
    }

    if (paths.length === 0) {
      this.toast(t('drop.unreadable'));
      return;
    }
    if (paths.length === 1) {
      await this.showAddDialog({ mode: 'file', filePath: paths[0] });
      return;
    }
    this.confirmAddMany(paths);
  }

  /** Confirmation for a drop of several `.torrent` files at once. */
  private confirmAddMany(paths: string[]): void {
    openModal({
      title: t('dialog.addManyTitle'),
      width: 440,
      body: el(
        'div',
        { class: 'form' },
        el('p', { class: 'dialog-text', text: t('dialog.addManyBody', { count: paths.length }) }),
      ),
      buttons: [
        { label: t('common.cancel') },
        { label: t('common.add'), primary: true, onClick: () => void this.addManyTorrents(paths) },
      ],
    });
  }

  /** Adds the dropped files with the default folder and sub folder rules. */
  private async addManyTorrents(paths: string[]): Promise<void> {
    const options: AddTorrentOptions = {
      createSubfolder: this.settings.createSubfolderDefault,
    };
    let added = 0;
    let failed = 0;
    for (const path of paths) {
      try {
        await this.provider.addFile(path, options);
        added += 1;
      } catch (err) {
        failed += 1;
        console.warn('[brickman-torrent] cannot add a dropped torrent', path, err);
      }
    }
    if (added > 0) {
      this.state.filter = { kind: 'all' };
      this.toast(t('toast.addedMany', { count: added }));
    }
    if (failed > 0) this.toast(t('toast.failedMany', { count: failed }));
    await this.refresh(true);
  }

  // ------------------------------------------------------------- data flow

  private async refresh(forceDetails = false): Promise<void> {
    try {
      const powerStatus = this.provider.powerStatus
        ? this.provider.powerStatus()
        : Promise.resolve(null);
      const [torrents, stats, power] = await Promise.all([
        this.provider.list(),
        this.provider.stats(),
        powerStatus,
      ]);
      this.state.torrents = torrents;
      this.state.stats = stats;
      this.powerStatus = power;

      this.detectCompleted(torrents);

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

  /**
   * "Download finished" is the transition from below 100 % to 100 % between two
   * polls: a list restored from the last session stays quiet, and a torrent that
   * seeds for hours does not notify again on every tick.
   */
  private detectCompleted(torrents: Torrent[]): void {
    for (const torrent of torrents) {
      const done = torrent.progress >= 0.999;
      const previous = this.completedSeen.get(torrent.id);
      this.completedSeen.set(torrent.id, done);
      if (previous === false && done) this.announceCompletion(torrent);
    }
    const known = new Set(torrents.map((torrent) => torrent.id));
    for (const id of [...this.completedSeen.keys()]) {
      if (!known.has(id)) this.completedSeen.delete(id);
    }
  }

  /** System notification; a toast stands in where there is no native one. */
  private announceCompletion(torrent: Torrent): void {
    if (!this.settings.notifyOnComplete) return;
    const { id, name, savePath } = torrent;
    void notifyCompletion({ id, name, folder: savePath }).then((native) => {
      if (native) return;
      // Mock data in a browser: the console keeps the path, the toast tells
      // the user. A refused permission ends up here as well.
      console.info('[brickman-torrent] download finished:', name, savePath);
      this.toast(t('notify.completed', { name }));
    });
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
    this.renderPowerBanner();
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
      renderHeader(this.dom.thead, this.state.sort, (key) => this.toggleSort(key), this.dom.layout);
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

  // ---------------------------------------------------------- column widths

  /** The user dragged a divider: remember the widths with the rest of the settings. */
  private saveColumnWidths(widths: ColumnWidths): void {
    this.settings = { ...this.settings, columnWidths: widths };
    void saveSettings(this.provider, this.settings);
  }

  /** "Reset column widths" in the header context menu. */
  private resetColumnWidths(): void {
    this.dom.layout.reset();
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
    const port = stats?.port ?? 0;
    // Three states: no listener at all, listening, listening with UPnP asked
    // for. librqbit reports no UPnP result, so the title says "requested" and
    // never claims the router accepted the mapping.
    const portTitle = !portOpen
      ? t('statusbar.portClosedHint')
      : stats?.upnpRequested
        ? t('statusbar.portHintUpnp', { port })
        : t('statusbar.portHint', { port });
    const portText = !portOpen
      ? port > 0
        ? t('statusbar.portClosed', { port })
        : t('statusbar.portOff')
      : t('statusbar.portOpen', { port });
    left.appendChild(
      el(
        'span',
        { class: 'sb-item sb-port', title: portTitle },
        el('span', { class: `sb-dot ${portOpen ? 'ok' : 'err'}` }),
        el('span', { text: portText }),
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

  /**
   * Countdown banner. Created once and only updated afterwards, so the "Cancel"
   * button does not jump away under the pointer on the one-second poll.
   */
  private renderPowerBanner(): void {
    const status = this.powerStatus;
    if (!status || !status.pending) {
      if (this.powerBanner) {
        this.powerBanner.remove();
        this.powerBanner = null;
      }
      return;
    }

    if (!this.powerBanner) {
      const cancel = el('button', {
        class: 'btn power-cancel',
        type: 'button',
        text: t('power.cancel'),
      });
      cancel.addEventListener('click', () => {
        void this.cancelPowerOff();
      });
      this.powerBanner = el(
        'div',
        { class: 'power-banner', role: 'alert' },
        el('span', { class: 'power-text' }),
        cancel,
      );
      document.body.appendChild(this.powerBanner);
    }

    const text = this.powerBanner.querySelector('.power-text');
    if (!text) return;
    const label = t(POWER_BANNER_KEYS[status.action], { seconds: status.secondsLeft });
    text.textContent = status.dryRun ? `${label} — ${t('power.dryRun')}` : label;
  }

  /**
   * Handing the "Connections" settings to the engine. The peer limit and the
   * trackers are used by the next torrents; a changed listener (UPnP / uTP) is
   * reported as `restartRequired`, and the user is told instead of being left
   * with a switch that quietly does nothing.
   */
  private pushConnectionSettings(settings: AppSettings): Promise<unknown> {
    const apply = this.provider.setConnectionSettings;
    if (!apply) return Promise.resolve();
    return apply
      .call(this.provider, {
        upnpEnabled: settings.upnpEnabled,
        utpEnabled: settings.utpEnabled,
        peerLimit: settings.peerLimit,
        extraTrackers: settings.extraTrackers,
      })
      .then((change) => {
        if (change?.restartRequired) this.toast(t('toast.restartRequired'));
        return change;
      })
      .catch((err: unknown) => {
        console.error('[brickman-torrent] cannot apply the connection settings', err);
      });
  }

  /** Handing the settings to the engine; the engine owns the countdown. */
  private pushPowerSettings(settings: AppSettings): Promise<unknown> {
    return Promise.resolve(
      this.provider.setPowerSettings?.({
        action: settings.onDownloadsComplete,
        delaySecs: settings.powerDelaySecs,
      }),
    ).catch((err: unknown) => {
      console.error('[brickman-torrent] cannot apply the power settings', err);
    });
  }

  private async cancelPowerOff(): Promise<void> {    try {
      await this.provider.cancelPowerOff?.();
    } catch (err) {
      console.error('[brickman-torrent] cannot cancel the shutdown', err);
    }
    if (this.powerStatus) this.powerStatus = { ...this.powerStatus, pending: false, secondsLeft: 0 };
    this.renderPowerBanner();
    await this.refresh();
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
   * "Pause all" of the tray menu: every torrent that is downloading or waiting
   * in the queue stops; seeding and finished ones are left alone.
   */
  async pauseAll(): Promise<void> {
    const ids = this.state.torrents
      .filter((torrent) => {
        const status = effectiveStatus(torrent);
        return status === 'downloading' || status === 'queued';
      })
      .map((torrent) => torrent.id);
    if (ids.length === 0) return;
    await this.provider.pause(ids);
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

  // ----------------------------------------------------------------- adding

  /** "Add file": pick the `.torrent`, look inside it, then ask about the folder. */
  private openAddTorrentFile(): void {
    const picker = this.provider.pickTorrentFile;
    if (!picker) {
      this.showAddDialog({ mode: 'file', filePath: '', preview: null });
      return;
    }
    void picker
      .call(this.provider)
      .then((path) => {
        // A cancelled file dialog adds nothing and opens nothing.
        if (!path) return;
        return this.showAddDialog({ mode: 'file', filePath: path });
      })
      .catch((err: unknown) => this.toast(errorText(err)));
  }

  private openAddMagnet(): void {
    this.showAddDialog({
      mode: 'magnet',
      uri: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Sintel.2010.2160p.mkv',
    });
  }

  // ----------------------------------------------------------- incoming links

  /**
   * Links the shell hands over: a `magnet:` link from the command line of this
   * or a second launch, a `.torrent` file from a double click. The engine
   * buffers them until this subscription exists, so nothing is lost while the
   * window is still starting.
   */
  private subscribeLinks(): void {
    const subscribe = this.provider.onLinkReceived;
    if (!subscribe) return;
    this.unsubscribeLinks = subscribe.call(this.provider, (payload) => this.handleLink(payload));
  }

  private handleLink(payload: LinkPayload): void {
    if (payload.kind === 'magnet') {
      void this.showAddDialog({ mode: 'magnet', uri: payload.value });
      return;
    }
    if (!payload.exists) {
      this.toast(t('toast.torrentNotFound', { path: payload.value }));
      return;
    }
    void this.addLinkedTorrent(payload.value);
  }

  /** A `.torrent` file handed over by the shell: added without a dialog. */
  private async addLinkedTorrent(path: string): Promise<void> {
    try {
      const torrent = await this.provider.addFile(path);
      this.state.selection = new Set([torrent.id]);
      this.state.anchorId = torrent.id;
      this.state.filter = { kind: 'all' };
      this.toast(t('toast.added', { name: torrent.name }));
      await this.refresh(true);
    } catch (err) {
      this.toast(errorText(err));
    }
  }

  /**
   * Ctrl+V in the main window: a magnet link on the clipboard opens the add
   * dialog. Anything else is left to the normal paste — this runs only when no
   * input has the focus and no dialog is open.
   */
  private async pasteMagnetLink(): Promise<void> {
    const read = this.provider.readClipboard;
    if (!read) return;
    let text: string | null;
    try {
      text = await read.call(this.provider);
    } catch (err) {
      console.warn('[brickman-torrent] cannot read the clipboard', err);
      return;
    }
    const link = text?.trim() ?? '';
    if (!link.toLowerCase().startsWith('magnet:')) return;
    await this.showAddDialog({ mode: 'magnet', uri: link });
  }

  /**
   * Opens the add dialog. A `.torrent` file is previewed first, so the sub
   * folder checkbox starts in the right state and an unreadable file is
   * reported before the dialog is even shown.
   */
  private async showAddDialog(options: {
    mode: 'file' | 'magnet';
    filePath?: string;
    uri?: string;
    preview?: TorrentPreview | null;
  }): Promise<void> {
    let preview = options.preview;
    if (options.mode === 'file' && options.filePath && this.provider.previewFile) {
      try {
        preview = await this.provider.previewFile.call(this.provider, options.filePath);
      } catch (err) {
        this.toast(errorText(err));
        return;
      }
    }

    openAddDialog({
      provider: this.provider,
      settings: this.settings,
      mode: options.mode,
      filePath: options.filePath,
      uri: options.uri,
      preview,
      defaultDir: this.systemDownloadDir,
      onSubmit: (request) => this.submitAdd(request),
    });
  }

  /** Adds the torrent; a thrown error keeps the dialog open with its message. */
  private async submitAdd(request: AddDialogRequest): Promise<void> {
    const options: AddTorrentOptions = {
      outputDir: request.outputDir || undefined,
      createSubfolder: request.createSubfolder,
      startPaused: request.startPaused,
    };
    const torrent =
      request.mode === 'file'
        ? await this.provider.addFile(request.filePath, options)
        : await this.provider.addMagnet(request.uri, options);

    this.state.selection = new Set([torrent.id]);
    this.state.anchorId = torrent.id;
    this.state.filter = { kind: 'all' };
    this.toast(t('toast.added', { name: torrent.name }));

    this.rememberFolder(request);
    await this.refresh(true);
  }

  /**
   * Keeps the folder of a successful add: it goes to the top of the recent list
   * (which survives restarts with the settings) and, when the user asked for
   * it, becomes the folder for the next torrents.
   */
  private rememberFolder(request: AddDialogRequest): void {
    const used = request.outputDir || this.settings.downloadDir || this.systemDownloadDir;
    const previousDir = this.settings.downloadDir;
    let next: AppSettings = this.settings;
    if (used) {
      next = { ...next, recentFolders: withRecentFolder(next.recentFolders, used) };
    }
    if (request.rememberAsDefault && request.outputDir) {
      next = { ...next, downloadDir: request.outputDir };
    }
    this.settings = next;
    void saveSettings(this.provider, next);

    if (next.downloadDir !== previousDir && next.downloadDir) {
      void this.provider
        .setDownloadDir?.(next.downloadDir)
        .catch((err: unknown) =>
          console.error('[brickman-torrent] cannot set the default folder', err),
        );
    }
  }

  /** System default download folder; empty when the provider has none. */
  private async resolveSystemDownloadDir(): Promise<string> {
    const ask = this.provider.defaultDownloadDir;
    if (!ask) return '';
    try {
      return await ask.call(this.provider);
    } catch (err) {
      console.warn('[brickman-torrent] cannot read the default download folder', err);
      return '';
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
        ...this.folderItems(torrent),
        { separator: true },
        { label: t('menu.remove'), action: () => this.confirmRemove([...this.state.selection]) },
      ],
      x,
      y,
    );
  }

  // --------------------------------------------------------------- folders

  /**
   * "Open folder" and "Change download folder…". The second one is refused for
   * a torrent the engine is running: its files are open, and the core moves
   * them to the new place.
   */
  private folderItems(torrent: Torrent | undefined): MenuItem[] {
    const items: MenuItem[] = [];
    const open = this.provider.openFolder;
    items.push({
      label: t('menu.openFolder'),
      disabled: !open || !torrent,
      title: open ? undefined : t('menu.openFolderUnavailable'),
      action: torrent ? () => this.openTorrentFolder(torrent.id) : undefined,
    });

    const change = this.provider.setTorrentOutputDir;
    const canChange = torrent !== undefined && this.canChangeFolder(torrent);
    items.push({
      label: t('menu.changeFolder'),
      disabled: !change || !canChange,
      title: canChange ? undefined : t('menu.changeFolderHint'),
      action:
        torrent && change && canChange
          ? () =>
              openChangeFolderDialog({
                provider: this.provider,
                settings: this.settings,
                torrent,
                onDone: (result) => void this.folderChanged(result),
              })
          : undefined,
    });
    return items;
  }

  /** Opens the folder of a torrent: row menu and the finish notification. */
  private openTorrentFolder(id: string): void {
    const open = this.provider.openFolder;
    if (!open) return;
    void open
      .call(this.provider, { id })
      .catch((err: unknown) => this.toast(errorText(err)));
  }

  /** Only a torrent the engine is not running can be moved. */
  private canChangeFolder(torrent: Torrent): boolean {
    const status = effectiveStatus(torrent);
    return status === 'paused' || status === 'queued' || status === 'stopped';
  }

  private async folderChanged(change: OutputDirChange): Promise<void> {
    if (change.movedFiles > 0) {
      this.toast(t('toast.movedFiles', { count: change.movedFiles }));
    }
    if (change.failedMoves.length > 0) {
      this.toast(t('toast.movedFailed', { count: change.failedMoves.length }));
    }
    this.state.selection = new Set([change.torrent.id]);
    this.state.anchorId = change.torrent.id;
    this.detailId = null;
    await this.refresh(true);
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
      provider: this.provider,
      defaultDir: this.systemDownloadDir,
      onMockFinishDownloads: () => this.provider.mockHooks?.finishAllDownloads?.(),
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
    void saveSettings(this.provider, next);
    this.pushCloseToTray(next.closeToTray);

    if (themeChanged) applyTheme(next.theme);
    if (localeChanged) {
      setLocale(next.locale);
      this.updateTrayLabels();
    }

    await Promise.all([
      this.provider.setMaxActive(next.maxActive),
      this.provider.setLimits({ downLimit: next.downLimit, upLimit: next.upLimit }),
      this.provider.setDownloadDir?.(next.downloadDir),
      this.pushPowerSettings(next),
      this.pushConnectionSettings(next),
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
    void saveSettings(this.provider, this.settings);
    setLocale(locale);
    this.updateTrayLabels();
    this.buildShell();
    this.render(true);
    if (this.settings.locale !== getLocale()) {
      console.warn('[brickman-torrent] locale did not switch');
    }
  }

  private toggleTheme(): void {
    const theme: AppSettings['theme'] = this.settings.theme === 'light' ? 'dark' : 'light';
    this.settings = { ...this.settings, theme };
    void saveSettings(this.provider, this.settings);
    applyTheme(theme);
    this.updateThemeButton();
  }

  /** Tray menu texts follow the UI language (the tray itself lives in Rust). */
  private updateTrayLabels(): void {
    const setLabels = this.provider.setTrayLabels;
    if (!setLabels) return;
    void setLabels
      .call(this.provider, t('tray.show'), t('tray.pauseAll'), t('tray.quit'))
      .catch((err: unknown) => console.warn('[brickman-torrent] cannot set the tray labels', err));
  }

  /** Whether closing the window hides it into the tray (a shell setting). */
  private pushCloseToTray(enabled: boolean): void {
    const apply = this.provider.setCloseToTray;
    if (!apply) return;
    void apply
      .call(this.provider, enabled)
      .catch((err: unknown) => console.warn('[brickman-torrent] cannot set close to tray', err));
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
        this.updaterReady = await this.updaterAvailable();
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

  /**
   * In-app install needs the updater and the release signing key. Without a key
   * (`pubkey` empty in tauri.conf.json) the dialog only offers the release page,
   * which is exactly what it did before the updater existed.
   */
  private async updaterAvailable(): Promise<boolean> {
    const ready = this.provider.updaterReady;
    if (!ready || !this.provider.installUpdate) return false;
    try {
      return await ready.call(this.provider);
    } catch (err) {
      console.warn('[brickman-torrent] cannot query the updater state', err);
      return false;
    }
  }

  private openUpdateDialog(): void {
    const info = this.updateInfo;
    if (!info || !info.available || !info.version) return;

    const changelog = el(
      'ul',
      { class: 'update-changelog' },
      ...info.changelog.map((line) => el('li', { text: t(line) })),
    );
    // Progress and the result of the install land here; the buttons stay put.
    const status = el('div', { class: 'update-progress', role: 'status' });

    const buttons: ModalButton[] = [{ label: t('update.later') }];
    if (this.updaterReady) {
      buttons.push({
        label: t('update.install'),
        primary: true,
        onClick: () => this.installUpdate(info, status),
      });
    } else {
      buttons.push({
        label: t('update.download'),
        primary: true,
        onClick: () => {
          if (info.url) void this.provider.openExternal(info.url);
          this.toast(t('update.downloadStub'));
        },
      });
    }

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
        el('div', {
          class: 'update-note',
          text: t(this.updaterReady ? 'update.autoHint' : 'update.downloadHint'),
        }),
        status,
      ),
      buttons,
    });
  }

  /**
   * Downloads and installs the update. Any failure - no key, no `latest.json`
   * yet, a rejected signature, a network error - falls back to the release page
   * instead of leaving the user with a dead button.
   */
  private async installUpdate(info: UpdateInfo, status: HTMLElement): Promise<boolean> {
    const install = this.provider.installUpdate;
    if (!install) {
      if (info.url) void this.provider.openExternal(info.url);
      return false;
    }

    status.textContent = t('update.downloadProgress', { percent: 0 });
    try {
      await install.call(this.provider, (percent) => {
        status.textContent =
          percent >= 100
            ? t('update.installing')
            : t('update.downloadProgress', { percent });
      });
      // Reaching this line means the app did not restart by itself.
      status.textContent = t('update.restarting');
    } catch (err) {
      console.error('[brickman-torrent] in-app update failed', err);
      status.textContent = t('update.installFailed');
      this.toast(t('update.installFailed'));
      if (info.url) void this.provider.openExternal(info.url);
    }
    // A restart or the browser is the actual result, not closing the dialog.
    return false;
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

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      // A magnet link on the clipboard opens the add dialog; any other text is
      // a normal paste and is not touched. `preventDefault` is deliberately not
      // called: there is nothing to paste into outside the inputs above.
      void this.pasteMagnetLink();
      return;
    }

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
