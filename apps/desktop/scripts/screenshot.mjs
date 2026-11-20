// Screenshot helper: renders the mockup into docs/*.png using the locally
// installed Edge/Chrome (no browser download, no Playwright install step).
//
//   npm run dev            (in one terminal)
//   npm run shot           (in another)
//
// Optional: npm run shot -- http://127.0.0.1:1420

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(here, '..', 'docs');
mkdirSync(docsDir, { recursive: true });

const url = process.argv[2] ?? 'http://127.0.0.1:1420';
const OUT = (name) => resolve(docsDir, name);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({
  viewport: { width: 1100, height: 700 },
  deviceScaleFactor: 2,
});

const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});

await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('.torrent-table tbody tr[data-id]', { timeout: 15000 });

// Select a downloading row so the details panel is populated.
const clickRow = async (needle) => {
  await page.evaluate((text) => {
    const row = [...document.querySelectorAll('tr[data-id]')].find((node) =>
      node.textContent?.includes(text),
    );
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, needle);
  await page.waitForTimeout(250);
};

const clickTab = async (index) => {
  await page.evaluate((tabIndex) => {
    const tabs = document.querySelectorAll('.dt-tab');
    tabs[tabIndex]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, index);
  await page.waitForTimeout(250);
};

await clickRow('Sintel');
await page.waitForTimeout(2600); // let the startup update check finish
await page.screenshot({ path: OUT('mockup.png') });

await clickTab(1);
await page.screenshot({ path: OUT('mockup-files.png') });

// Dark theme via the toolbar toggle (aria-label is the English string).
await page.evaluate(() => {
  const button = document.querySelector('.tb-btn[aria-label="Switch to dark theme"]');
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(350);
await page.screenshot({ path: OUT('mockup-dark.png') });

const state = await page.evaluate(() => ({
  rows: document.querySelectorAll('tr[data-id]').length,
  tabs: [...document.querySelectorAll('.dt-tab')].map((tab) => tab.textContent),
  status: document.querySelector('.statusbar')?.textContent ?? '',
  theme: document.documentElement.dataset.theme,
}));

await browser.close();

console.log(JSON.stringify(state, null, 2));
if (problems.length > 0) {
  console.error('Browser problems:');
  for (const problem of problems) console.error(' -', problem);
  process.exitCode = 1;
} else {
  console.log('No console errors, no page errors.');
}
