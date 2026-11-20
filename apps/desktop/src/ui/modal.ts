// Modal dialog helper (no <dialog> quirks, works in plain browser + webview).

import { el } from './dom';

export interface ModalButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  /**
   * Closes the dialog when the handler returns nothing or `true` (a resolved
   * promise counts the same). `false` keeps the dialog open, which is what an
   * async handler needs when its validation failed and the message is shown
   * inside the dialog.
   */
  onClick?: (close: () => void) => void | boolean | Promise<void | boolean>;
}

export interface ModalOptions {
  title: string;
  body: Node;
  buttons?: ModalButton[];
  width?: number;
  onClose?: () => void;
}

export interface ModalHandle {
  close: () => void;
  root: HTMLElement;
}

let activeModal: { close: () => void } | null = null;

export function openModal(options: ModalOptions): ModalHandle {
  activeModal?.close();

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (activeModal?.close === close) activeModal = null;
    options.onClose?.();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const body = el('div', { class: 'modal-body' });
  body.appendChild(options.body);

  const footer = el('div', { class: 'modal-footer' });
  for (const button of options.buttons ?? []) {
    const node = el(
      'button',
      {
        class: `btn${button.primary ? ' primary' : ''}${button.danger ? ' danger' : ''}`,
        type: 'button',
      },
      button.label,
    );
    node.addEventListener('click', () => {
      const result = button.onClick?.(() => close());
      if (result instanceof Promise) {
        // Async handlers (engine calls) decide themselves: `false` means the
        // dialog stays open with an error inside it.
        node.disabled = true;
        void result
          .then((keepOpen) => {
            if (keepOpen !== false) close();
          })
          .catch((error: unknown) => {
            console.error('[brickman-torrent] dialog action failed', error);
          })
          .finally(() => {
            node.disabled = false;
          });
        return;
      }
      if (result !== false) close();
    });
    footer.appendChild(node);
  }

  const titleText = el('span', { class: 'modal-title', text: options.title });
  const closeButton = el('button', {
    class: 'modal-close',
    type: 'button',
    title: 'Close',
    'aria-label': 'Close',
  });
  closeButton.textContent = '\u00d7';
  closeButton.addEventListener('click', () => close());

  const dialog = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
    el('div', { class: 'modal-header' }, titleText, closeButton),
    body,
    footer,
  );

  const overlay = el('div', { class: 'modal-overlay' }, dialog);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  if (options.width) dialog.style.width = `${options.width}px`;

  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  activeModal = { close };

  const firstField = body.querySelector<HTMLElement>(
    'input:not([type="checkbox"]), select, textarea, button',
  );
  window.setTimeout(() => {
    firstField?.focus();
    if (firstField instanceof HTMLInputElement) firstField.select();
  }, 0);

  return { close, root: overlay };
}
