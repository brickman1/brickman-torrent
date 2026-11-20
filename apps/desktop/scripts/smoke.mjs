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

check('15 mock torrents rendered', (await rowCount()) === 15, String(await rowCount()));

// Legal content only: no commercial titles or scene release markers.
const bannedNames =
  /Matrix|Pink Floyd|Nine Inch Nails|Cubase|Zomboid|-GRP|\bSample\b|\bSubs\b/i;
const tableText = await page.locator('.torrent-table').innerText();
check('mock data has no commercial/pirate names', !bannedNames.test(tableText), tableText.slice(0, 120));

// --- sorting -------------------------------------------------------------
await clickHeader('name');
const names = await page.$$eval('td.name-cell', (cells) => cells.map((cell) => cell.textContent?.trim() ?? ''));
const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en'));
check('header click sorts by name (asc)', JSON.stringify(names) === JSON.stringify(sorted));
await clickHeader('name');
const namesDesc = await page.$$eval('td.name-cell', (cells) => cells.map((cell) => cell.textContent?.trim() ?? ''));
check('second click reverses order', JSON.stringify(namesDesc) === JSON.stringify([...names].reverse()));

// --- sidebar filters -----------------------------------------------------
await clickIn('.side-item .side-label', 'Queued');
await page.waitForTimeout(200);
check('Queued filter shows 2 rows', (await rowCount()) === 2, String(await rowCount()));
const queuedStatuses = await page.$$eval('td.status-cell', (cells) => cells.map((cell) => cell.textContent?.trim()));
check('all filtered rows are Queued', queuedStatuses.every((text) => text === 'Queued'), queuedStatuses.join(','));

await clickIn('.side-item .side-label', 'Stopped');
await page.waitForTimeout(200);
check('Stopped filter shows 1 row', (await rowCount()) === 1, String(await rowCount()));
const stoppedStatuses = await page.$$eval('td.status-cell', (cells) => cells.map((cell) => cell.textContent?.trim()));
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

// --- context menu + priority submenu ------------------------------------
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const row = document.querySelector('tr[data-id]');
  row?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 200 }),
  );
});
await page.waitForSelector('.ctx-menu');
const menuText = await page.locator('.ctx-menu').innerText();
check('context menu has Start/Pause/Stop/Priority/Remove', ['Start', 'Pause', 'Stop', 'Priority', 'Remove'].every((label) => menuText.includes(label)), menuText.replace(/\s+/g, ' '));
const submenuVisible = await (async () => {
  await page.locator('.ctx-menu .menu-item.has-sub').first().click();
  await page.waitForTimeout(120);
  return page.locator('.ctx-menu .menu-item.has-sub .submenu').first().isVisible();
})();
check('priority submenu opens on click', submenuVisible);
await page.evaluate(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
await page.waitForTimeout(120);
check('Escape closes context menu', (await page.locator('.ctx-menu').count()) === 0);

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
check('settings shows max active field', (await page.locator('.settings-form').innerText()).includes('Maximum active torrents'));
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
await page.locator('.tb-select').selectOption('ru');
await page.waitForTimeout(300);
const ruSidebar = await page.locator('.side-item').first().innerText();
check('RU locale switches sidebar', ruSidebar.includes('Все'), ruSidebar.replace(/\s+/g, ' '));
const ruHeader = await page.locator('th.col-name').innerText();
check('RU locale switches table header', ruHeader.includes('Имя'), ruHeader);
await page.locator('.tb-select').selectOption('en');
await page.waitForTimeout(300);

check('no console/page errors', errors.length === 0, errors.join(' | '));

await browser.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const item of results) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}`);
if (failed.length > 0) process.exitCode = 1;
