// Minimal context menu with nested submenu (μTorrent style).

import { el } from './dom';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  action?: () => void;
}

let current: HTMLElement | null = null;
let detach: (() => void) | null = null;

export function closeContextMenu(): void {
  if (detach) {
    detach();
    detach = null;
  }
  if (current) {
    current.remove();
    current = null;
  }
}

export function showContextMenu(items: MenuItem[], x: number, y: number): void {
  closeContextMenu();

  const menu = buildMenu(items, false);
  menu.classList.add('ctx-menu');
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  if (left > window.innerWidth * 0.6) menu.classList.add('flip-left');

  const onPointerDown = (event: MouseEvent): void => {
    if (menu.contains(event.target as Node)) return;
    closeContextMenu();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeContextMenu();
  };
  const onWindowChange = (): void => closeContextMenu();

  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('blur', onWindowChange);
  document.addEventListener('scroll', onWindowChange, true);

  detach = (): void => {
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onWindowChange);
    window.removeEventListener('blur', onWindowChange);
    document.removeEventListener('scroll', onWindowChange, true);
  };
  current = menu;
}

function buildMenu(items: MenuItem[], isSubmenu: boolean): HTMLElement {
  const menu = el('div', {
    class: `menu${isSubmenu ? ' submenu' : ''}`,
    role: 'menu',
  });

  for (const item of items) {
    if (item.separator) {
      menu.appendChild(el('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }

    const row = el(
      'div',
      {
        class: `menu-item${item.disabled ? ' disabled' : ''}${item.submenu ? ' has-sub' : ''}`,
        role: 'menuitem',
        'aria-disabled': item.disabled ? 'true' : 'false',
        tabindex: item.disabled ? '-1' : '0',
      },
      el('span', { class: 'menu-label', text: item.label ?? '' }),
      item.shortcut ? el('span', { class: 'menu-shortcut', text: item.shortcut }) : null,
      item.submenu ? el('span', { class: 'menu-arrow', text: '▸' }) : null,
    );

    if (item.submenu) {
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        row.classList.toggle('open');
      });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          row.classList.toggle('open');
        }
      });
      row.appendChild(buildMenu(item.submenu, true));
    } else if (!item.disabled && item.action) {
      const action = item.action;
      row.addEventListener('click', () => {
        closeContextMenu();
        action();
      });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          closeContextMenu();
          action();
        }
      });
    }

    menu.appendChild(row);
  }

  return menu;
}
