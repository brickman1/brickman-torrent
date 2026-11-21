// Interaction smoke test for the mock UI (headless Edge, no browser download).
//   npm run dev    (in one terminal)
//   npm run smoke  (in another)

import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://127.0.0.1:1420';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  if (!ok) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('tr[data-id]');

const rowCount = () => page.locator('tr[data-id]').count();
const selectedCount = () => page.locator('tr[data-id].selected').count();
const clickIn = (selector, text) =>
  page.evaluate(
    ({ selector, text }) => {
      const nodes = [...document.querySelectorAll(selector)];
      const target = text ? nodes.find((node) => node.textContent?.trim() === text) : nodes[0];
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(target);
    },
    { selector, text },
  );
const clickHeader = (key) =>
  page.evaluate((column) => {
    document
      .querySelector(`th.col-${column}`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, key);
const statusText = () => page.locator('.statusbar').innerText();
const names = () => page.$$eval('td.name-cell', (cells) => cells.map((cell) => cell.textContent?.trim() ?? ''));
const statuses = () =>
  page.$$eval('td.status-cell', (cells) => cells.map((cell) => cell.textContent?.trim() ?? ''));
const ordinals = () =>
  page.$$eval('td.ordinal .ordinal-number', (cells) => cells.map((cell) => cell.textContent?.trim() ?? ''));

check('15 mock torrents rendered', (await rowCount()) === 15, String(await rowCount()));

// Legal content only: no commercial titles or scene release markers.
const bannedNames =
  /Matrix|Pink Floyd|Nine Inch Nails|Cubase|Zomboid|-GRP|\bSample\b|\bSubs\b/i;
const tableText = await page.locator('.torrent-table').innerText();
check('mock data has no commercial/pirate names', !bannedNames.test(tableText), tableText.slice(0, 120));

// --- queue column --------------------------------------------------------
const queueNumbers = await ordinals();
check(
  'default sort shows the queue in "#" as 1..15',
  JSON.stringify(queueNumbers) === JSON.stringify(Array.from({ length: 15 }, (_, i) => String(i + 1))),
  queueNumbers.join(','),
);
const activeStatuses = await statuses();
check(
  'exactly one download runs at a time (max active = 1)',
  activeStatuses.filter((text) => text === 'Downloading').length === 1,
  activeStatuses.join(','),
);
check(
  'the rest of the queue waits as Queued',
  activeStatuses.filter((text) => text === 'Queued').length >= 1,
  activeStatuses.join(','),
);
check('one top-of-queue marker', (await page.locator('td.ordinal .queue-marker').count()) === 1);

// --- sorting -------------------------------------------------------------
await clickHeader('name');
const sortedNames = await names();
const expectedAsc = [...sortedNames].sort((a, b) => a.localeCompare(b, 'en'));
check('header click sorts by name (asc)', JSON.stringify(sortedNames) === JSON.stringify(expectedAsc));
await clickHeader('name');
const namesDesc = await names();
check(
  'second click reverses order',
  JSON.stringify(namesDesc) === JSON.stringify([...sortedNames].reverse()),
);

// Drag and drop is a queue edit, so it must be refused in a temporary view.
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('tr[data-id]')];
  const transfer = new DataTransfer();
  rows[2]?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
});
await page.waitForTimeout(150);
const sortToast = await page.locator('.toast').first().innerText().catch(() => '');
check('dragging outside "#" order explains itself', sortToast.includes('Sort by #'), sortToast);
await page.waitForTimeout(3300); // let the toast disappear

await clickHeader('ordinal');
check('clicking "#" restores the queue order', (await ordinals())[0] === '1');

// --- drag and drop reorders the queue ------------------------------------
const firstNameBefore = (await names())[0];
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('tr[data-id]')];
  const source = rows[2];
  const target = rows[0];
  if (!source || !target) return;
  const transfer = new DataTransfer();
  const rect = target.getBoundingClientRect();
  const point = { clientX: rect.left + 60, clientY: rect.top + 2 };
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer, ...point }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer, ...point }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
});
await page.waitForTimeout(800);
const afterDrop = await names();
check(
  'dropping a row on the top moves it to position 1',
  afterDrop[0] !== firstNameBefore && (await ordinals())[0] === '1',
  afterDrop.slice(0, 3).join(' | '),
);
check(
  'the queue stays 1..15 after the move',
  JSON.stringify(await ordinals()) ===
    JSON.stringify(Array.from({ length: 15 }, (_, i) => String(i + 1))),
);

// --- sidebar filters -----------------------------------------------------
await clickIn('.side-item .side-label', 'Queued');
await page.waitForTimeout(200);
const queuedRows = await rowCount();
const queuedStatuses = await statuses();
check('Queued filter shows the waiting torrents', queuedRows >= 1, String(queuedRows));
check('all filtered rows are Queued', queuedStatuses.every((text) => text === 'Queued'), queuedStatuses.join(','));

await clickIn('.side-item .side-label', 'Downloading');
await page.waitForTimeout(200);
check('Downloading filter shows the single active torrent', (await rowCount()) === 1, String(await rowCount()));

await clickIn('.side-item .side-label', 'Stopped');
await page.waitForTimeout(200);
check('Stopped filter shows 1 row', (await rowCount()) === 1, String(await rowCount()));
const stoppedStatuses = await statuses();
check('Stopped filter rows are Stopped', stoppedStatuses.every((text) => text === 'Stopped'), stoppedStatuses.join(','));

await clickIn('.side-item .side-label', 'All');
await page.waitForTimeout(200);
check('All filter restores 15 rows', (await rowCount()) === 15, String(await rowCount()));

// --- selection, details, keyboard ---------------------------------------
await page.evaluate(() => {
  const row = [...document.querySelectorAll('tr[data-id]')].find((node) =>
    node.textContent?.includes('Sintel'),
  );
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(250);
check('row selection highlights one row', (await selectedCount()) === 1, String(await selectedCount()));
const detailName = await page.locator('.general-name').innerText().catch(() => '');
check('details panel follows selection', detailName.includes('Sintel'), detailName);

await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
});
await page.waitForTimeout(250);
check('Ctrl+A selects all visible rows', (await selectedCount()) === 15, String(await selectedCount()));

await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
});
await page.waitForSelector('.modal-overlay');
const removeDialog = await page.locator('.modal').innerText();
check('Delete opens remove dialog', /Remove \d+ selected torrent/.test(removeDialog), removeDialog.slice(0, 80));
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(200);
check('cancel keeps all torrents', (await rowCount()) === 15, String(await rowCount()));

// --- context menu: queue actions ----------------------------------------
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const row = document.querySelector('tr[data-id]');
  row?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 200 }),
  );
});
await page.waitForSelector('.ctx-menu');
const menuText = await page.locator('.ctx-menu').innerText();
check(
  'context menu has queue commands',
  ['Start', 'Pause', 'Stop', 'Move to top', 'Move up', 'Move down', 'Move to position', 'Remove'].every(
    (label) => menuText.includes(label),
  ),
  menuText.replace(/\s+/g, ' '),
);
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.ctx-menu .menu-item')];
  const target = items.find((item) => item.textContent?.includes('Move to position'));
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.modal-overlay');
const positionDialog = await page.locator('.modal').innerText();
check('"Move to position" opens a number dialog', /Queue position/.test(positionDialog), positionDialog.slice(0, 80));
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(200);

// A numeric move must reorder the queue as well.
const firstBeforeNumberMove = (await names())[0];
await page.evaluate(() => {
  const row = [...document.querySelectorAll('tr[data-id]')][3];
  row?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 240 }),
  );
});
await page.waitForSelector('.ctx-menu');
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.ctx-menu .menu-item')];
  items.find((item) => item.textContent?.includes('Move to top'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(700);
const afterMenuMove = await names();
check(
  '"Move to top" moves the row to position 1',
  afterMenuMove[0] !== firstBeforeNumberMove && (await ordinals())[0] === '1',
  afterMenuMove[0],
);

// --- settings: toggle mock update answer --------------------------------
const openSettings = async () => {
  await page.locator('.tb-btn[aria-label="Settings"]').click();
  await page.waitForSelector('.settings-form');
};
const applySettings = async () => {
  await page.locator('.modal-footer .btn.primary').click();
  await page.waitForTimeout(250);
};
const toggleMockUpdate = async (checked) => {
  await page.locator('.mock-box input[type="checkbox"]').setChecked(checked);
};

await openSettings();
const settingsText = await page.locator('.settings-form').innerText();
check('settings shows maximum active downloads', settingsText.includes('Maximum active downloads'), settingsText.slice(0, 120));
check(
  'maximum active downloads defaults to 1',
  (await page.locator('.settings-form input[type="number"]').first().inputValue()) === '1',
);
await toggleMockUpdate(false);
await applySettings();
await page.locator('.tb-btn[aria-label="Check for updates"]').click();
await page.waitForTimeout(1400);
const upToDateText = await statusText();
check('manual check reports up to date', upToDateText.includes('latest version (0.1.0)'), upToDateText);

await openSettings();
await toggleMockUpdate(true);
await applySettings();
await page.locator('.tb-btn[aria-label="Check for updates"]').click();
await page.waitForTimeout(1400);
const updateDialog = await page.locator('.modal').innerText().catch(() => '');
check('update dialog opens with new version', updateDialog.includes('0.2.0') && /what's new/i.test(updateDialog), updateDialog.slice(0, 120));
check(
  'update dialog lists changelog',
  /what's new/i.test(updateDialog) && updateDialog.includes('Per-torrent bandwidth limits'),
);
await page.getByRole('button', { name: 'Later' }).click();
await page.waitForTimeout(250);
const availableText = await statusText();
check('status bar shows available update', availableText.includes('Update 0.2.0 available'), availableText);

// --- locale switch ------------------------------------------------------
const NATIVE_NAMES = [
  'English',
  'Русский',
  'Español',
  'Português (Brasil)',
  'Deutsch',
  'Français',
  'Italiano',
  'Türkçe',
  'Polski',
  '简体中文',
];
const localeOptions = await page.$$eval('.tb-select option', (nodes) =>
  nodes.map((node) => node.textContent?.trim() ?? ''),
);
check(
  'the switcher lists all 10 languages in their own names',
  localeOptions.length === NATIVE_NAMES.length &&
    NATIVE_NAMES.every((name) => localeOptions.includes(name)),
  localeOptions.join(' | '),
);

// Icon buttons keep their place when the select grows: only the select's own
// left edge may move, never the buttons.
const toolbarButtonLefts = () =>
  page.$$eval('.tb-btn', (nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
const toolbarFits = () =>
  page.evaluate(() => {
    const bar = document.querySelector('.toolbar');
    return Boolean(bar) && bar.scrollWidth <= bar.clientWidth + 1;
  });
const activeStatusText = () =>
  page.locator('.status.st-downloading').first().innerText().catch(() => '');
const storedLocale = () =>
  page.evaluate(() => {
    const raw = localStorage.getItem('brickman-torrent.settings.v1');
    return raw ? JSON.parse(raw).locale : null;
  });

const enButtonLefts = await toolbarButtonLefts();
const enStatus = await activeStatusText();
await page.locator('.tb-select').selectOption('de');
await page.waitForTimeout(300);
const deSidebar = (await page.locator('.side-item').first().innerText()).replace(/\s+/g, ' ');
check('DE locale switches the sidebar', deSidebar.includes('Alle'), deSidebar);
const deStatus = await activeStatusText();
check('DE locale switches the status column', deStatus === 'Lädt', deStatus);
check(
  'DE locale rebuilds the toolbar labels',
  (await page.locator('.tb-btn[aria-label="Einstellungen"]').count()) === 1,
);
check('DE choice is persisted in the settings', (await storedLocale()) === 'de', String(await storedLocale()));
check(
  'the toolbar buttons do not move on German strings',
  JSON.stringify(await toolbarButtonLefts()) === JSON.stringify(enButtonLefts),
  JSON.stringify(await toolbarButtonLefts()),
);
check('the toolbar does not overflow on German strings', await toolbarFits());

await page.locator('.tb-select').selectOption('en');
await page.waitForTimeout(300);
const backSidebar = (await page.locator('.side-item').first().innerText()).replace(/\s+/g, ' ');
check('switching back to EN restores the sidebar', backSidebar.includes('All'), backSidebar);
check('switching back to EN restores the status column', (await activeStatusText()) === enStatus, await activeStatusText());
check('EN choice is persisted in the settings', (await storedLocale()) === 'en', String(await storedLocale()));
check(
  'the toolbar buttons are back where they were',
  JSON.stringify(await toolbarButtonLefts()) === JSON.stringify(enButtonLefts),
);

// A non-Latin locale: the page language changes and the CJK font stack is in
// place, so Han characters are not left to a fallback that may not exist.
await page.locator('.tb-select').selectOption('zh-CN');
await page.waitForTimeout(300);
check(
  'zh-CN sets the document language',
  (await page.evaluate(() => document.documentElement.lang)) === 'zh-CN',
);
const zhSidebar = (await page.locator('.side-item').first().innerText()).replace(/\s+/g, ' ');
check('zh-CN locale switches the sidebar', zhSidebar.includes('全部'), zhSidebar);
const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
check(
  'the font stack carries a CJK fallback',
  /Microsoft YaHei/.test(bodyFont) && /PingFang SC/.test(bodyFont) && /Noto Sans CJK SC/.test(bodyFont),
  bodyFont,
);
await page.locator('.tb-select').selectOption('en');
await page.waitForTimeout(300);
check('EN is back after zh-CN', (await activeStatusText()) === enStatus, await activeStatusText());

// --- add dialog: folder, recent folders, validation ---------------------
const FOLDER = 'C:\\Temp\\Моя папка';
const openAddFile = async () => {
  await page.locator('.tb-btn[aria-label="Add file"]').click();
  await page.waitForSelector('.modal-overlay .add-form');
};
const folderInput = () => page.locator('.modal .folder-input');
const folderError = () => page.locator('.modal .field-error').innerText().catch(() => '');
const addPrimary = () => page.locator('.modal-footer .btn.primary').click();

await openAddFile();
check(
  'the add dialog starts with an empty folder when nothing was used yet',
  (await folderInput().inputValue()) === '',
  await folderInput().inputValue(),
);
check(
  'the recent folders list is empty before the first add',
  (await page.locator('.modal datalist option').count()) === 0,
);

// A folder that does not exist must be explained inside the dialog.
await folderInput().fill('Z:\\nope');
await addPrimary();
await page.waitForTimeout(400);
check(
  'a missing drive keeps the add dialog open',
  (await page.locator('.modal-overlay').count()) === 1,
);
const missingDriveError = await folderError();
check(
  'a missing drive is explained in the dialog, not as a failed start',
  /drive Z: is not available/i.test(missingDriveError),
  missingDriveError,
);

// The same directory the live test uses: a space and Cyrillic in the name.
await folderInput().fill(FOLDER);
await addPrimary();
await page.waitForTimeout(700);
check(
  'the dialog closes after a successful add',
  (await page.locator('.modal-overlay').count()) === 0,
);
check('the torrent was added to the table', (await rowCount()) === 16, String(await rowCount()));

const storedSettings = await page.evaluate(() => {
  const raw = localStorage.getItem('brickman-torrent.settings.v1');
  return raw ? JSON.parse(raw) : null;
});
check(
  'the folder of the add is persisted as a recent folder',
  Array.isArray(storedSettings?.recentFolders) && storedSettings.recentFolders[0] === FOLDER,
  JSON.stringify(storedSettings?.recentFolders),
);

await openAddFile();
const recentOptions = await page.$$eval('.modal datalist option', (nodes) =>
  nodes.map((node) => node.value),
);
check(
  'the add dialog starts with the last used folder',
  (await folderInput().inputValue()) === FOLDER,
  await folderInput().inputValue(),
);
check(
  'the last folder is offered in the recent folders list',
  recentOptions.includes(FOLDER),
  recentOptions.join(' | '),
);
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(200);

// --- context menu: folder commands --------------------------------------
const openMenuOnRowWithStatus = async (status) => {
  const found = await page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll('tr[data-id]')];
    const row = rows.find(
      (node) => node.querySelector('td.status-cell')?.textContent?.trim() === wanted,
    );
    if (!row) return false;
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 220 }),
    );
    return true;
  }, status);
  await page.waitForSelector('.ctx-menu');
  return found;
};
const menuItem = (label) =>
  page.evaluate((wanted) => {
    const item = [...document.querySelectorAll('.ctx-menu .menu-item')].find(
      (node) => node.querySelector('.menu-label')?.textContent?.trim() === wanted,
    );
    if (!item) return null;
    return {
      disabled: item.classList.contains('disabled'),
      ariaDisabled: item.getAttribute('aria-disabled'),
      title: item.getAttribute('title') ?? '',
    };
  }, label);

check('a downloading row offers the folder menu', await openMenuOnRowWithStatus('Downloading'));
const activeChange = await menuItem('Change download folder…');
check(
  '"Change download folder…" is disabled for an active torrent',
  activeChange?.disabled === true && activeChange?.ariaDisabled === 'true',
  JSON.stringify(activeChange),
);
check(
  'the disabled entry says what to do',
  /Stop the torrent/i.test(activeChange?.title ?? ''),
  activeChange?.title,
);
const activeOpen = await menuItem('Open folder');
check(
  '"Open folder" stays available for an active torrent',
  activeOpen?.disabled === false,
  JSON.stringify(activeOpen),
);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

check('a stopped row offers the folder menu', await openMenuOnRowWithStatus('Stopped'));
const stoppedChange = await menuItem('Change download folder…');
check(
  '"Change download folder…" is enabled for a stopped torrent',
  stoppedChange?.disabled === false,
  JSON.stringify(stoppedChange),
);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// --- links: handler registration ---------------------------------------
await openSettings();
await page.waitForTimeout(250); // the status is asked from the engine
const linksStatus = async () =>
  (await page.locator('.links-status-text').innerText()).trim();
const settingsTextWithLinks = await page.locator('.settings-form').innerText();
check(
  'settings has a Links section',
  // The section title is uppercased by CSS, and `innerText` reports it that way.
  /links/i.test(settingsTextWithLinks) && (await page.locator('.links-status-text').count()) === 1,
  settingsTextWithLinks.slice(-160),
);
check(
  'the handler starts as not registered',
  (await linksStatus()) === 'not registered',
  await linksStatus(),
);
check(
  '"Remove registration" is hidden while nothing was registered',
  !(await page.locator('.links-unregister').isVisible()),
);
await page.locator('.links-register').click();
await page.waitForTimeout(400);
check(
  '"Make default" switches the status to registered',
  (await linksStatus()) === 'registered',
  await linksStatus(),
);
check(
  '"Remove registration" appears after registering',
  await page.locator('.links-unregister').isVisible(),
);
await page.locator('.links-unregister').click();
await page.waitForTimeout(400);
check(
  '"Remove registration" puts the original state back',
  (await linksStatus()) === 'not registered',
  await linksStatus(),
);
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(200);

// --- links: Ctrl+V and link-received ------------------------------------
const PASTED = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Paste+Test';
const addSourceInput = () => page.locator('.modal .add-form .text-input').first();
const pressPaste = () =>
  page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
  });

await page.evaluate((text) => window.__torrentProvider.mockHooks.setClipboard(text), PASTED);
await pressPaste();
await page.waitForSelector('.modal-overlay .add-form');
check(
  'Ctrl+V with a magnet link opens the add dialog with that link',
  (await addSourceInput().inputValue()) === PASTED,
  await addSourceInput().inputValue(),
);
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(200);

await page.evaluate(() => window.__torrentProvider.mockHooks.setClipboard('just some text'));
await pressPaste();
await page.waitForTimeout(300);
check(
  'Ctrl+V with plain text does nothing',
  (await page.locator('.modal-overlay').count()) === 0,
);
await page.evaluate(() => window.__torrentProvider.mockHooks.setClipboard(null));

// A `.torrent` path that is gone must be reported, not silently dropped.
await page.evaluate(() => {
  window.__torrentProvider.mockHooks.emitLink({
    kind: 'torrent',
    value: 'C:\\nowhere\\gone.torrent',
    exists: false,
  });
});
await page.waitForTimeout(300);
const missingLinkToast = await page.locator('.toast').last().innerText().catch(() => '');
check(
  'a missing .torrent link shows a "file not found" error',
  /not found/i.test(missingLinkToast) && missingLinkToast.includes('gone.torrent'),
  missingLinkToast,
);

// A magnet link handed over by the shell opens the add dialog as well.
const LINKED = 'magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd&dn=Event+Test';
await page.evaluate((uri) => {
  window.__torrentProvider.mockHooks.emitLink({ kind: 'magnet', value: uri, exists: true });
}, LINKED);
await page.waitForSelector('.modal-overlay .add-form');
check(
  'a magnet link from the shell opens the add dialog',
  (await addSourceInput().inputValue()) === LINKED,
  await addSourceInput().inputValue(),
);
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(200);

check('no console/page errors', errors.length === 0, errors.join(' | '));

await browser.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const item of results) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`);
if (failed.length > 0) process.exitCode = 1;
