// Inline SVG icons (no CDN, no icon font).

import { el } from './dom';

export type IconName =
  | 'addFile'
  | 'addLink'
  | 'start'
  | 'pause'
  | 'stop'
  | 'remove'
  | 'settings'
  | 'refresh'
  | 'sun'
  | 'moon'
  | 'chevron'
  | 'folder'
  | 'tag';

const PATHS: Record<IconName, string> = {
  addFile:
    '<path d="M9 1.8H4.6A1.6 1.6 0 0 0 3 3.4v9.2a1.6 1.6 0 0 0 1.6 1.6h6.8A1.6 1.6 0 0 0 13 12.6V5.6z"/><path d="M9 1.8v3.8h4"/><path d="M8 9.4v3.2M6.4 11h3.2"/>',
  addLink:
    '<path d="M4.6 2.4v5.2a3.4 3.4 0 0 0 6.8 0V2.4"/><path d="M3.2 2.4h2.8M10 2.4h2.8"/><path d="M4.6 5.6h6.8"/>',
  start: '<path d="M4.2 2.4 13 8l-8.8 5.6z" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="3.8" y="2.6" width="3.2" height="10.8" fill="currentColor" stroke="none"/><rect x="9" y="2.6" width="3.2" height="10.8" fill="currentColor" stroke="none"/>',
  stop: '<rect x="3.4" y="3.4" width="9.2" height="9.2" fill="currentColor" stroke="none"/>',
  remove:
    '<path d="M2.6 4.4h10.8"/><path d="M6.2 4.4V3a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.4"/><path d="M4.2 4.4l.7 8.8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.8"/>',
  settings:
    '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>',
  refresh:
    '<path d="M2.8 9.4A5.4 5.4 0 0 1 11.9 4.4"/><path d="M12.6 2.4v3.2H9.4"/><path d="M13.2 6.6A5.4 5.4 0 0 1 4.1 11.6"/><path d="M3.4 13.6v-3.2h3.2"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"/>',
  moon: '<path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6z"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  folder:
    '<path d="M1.6 4.2a1 1 0 0 1 1-1h2.9l1.4 1.5h5.5a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z"/>',
  tag: '<path d="M2.4 2.4h5.2l6 6-5.2 5.2-6-6z"/><circle cx="5" cy="5" r="1.1" fill="currentColor" stroke="none"/>',
};

export function icon(name: IconName, className = ''): HTMLSpanElement {
  return el('span', {
    class: `ico${className ? ` ${className}` : ''}`,
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`,
  });
}
