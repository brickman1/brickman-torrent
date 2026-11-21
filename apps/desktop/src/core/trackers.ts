// Extra trackers: validation and the built-in list of well-known public ones.
//
// The list is only a convenience for the "add popular trackers" button: nothing
// is used unless the user puts it into the tracker field, and the field can be
// cleared again. Mirrors `brickman_core::parse_trackers` (scheme + host, exact
// de-duplication, the same cap), so the UI and the engine agree on what is a
// usable announce URL.

import { EXTRA_TRACKERS_LIMIT } from './types';

/**
 * Public BitTorrent trackers that answer for any torrent. Purely a starting
 * point: availability changes, and a torrent with no peers in it stays empty.
 */
export const POPULAR_TRACKERS: readonly string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://open.demonii.com:1339/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.0x7c0.com:6969/announce',
];

/** Schemes a tracker announce URL may use (the engine understands these). */
const TRACKER_SCHEMES = new Set(['udp:', 'http:', 'https:']);

/** A URL the engine can announce to; `null` for everything else. */
export function normalizeTracker(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!TRACKER_SCHEMES.has(url.protocol)) return null;
  if (!url.hostname) return null;
  return url.toString();
}

/**
 * Reads the tracker field: one URL per line, junk dropped, duplicates removed
 * and the list capped at {@link EXTRA_TRACKERS_LIMIT}.
 *
 * Multi-line input and a plain array of lines are both accepted.
 */
export function normalizeTrackers(value: unknown): string[] {
  const lines: string[] = [];
  if (typeof value === 'string') lines.push(...value.split(/\r?\n/));
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') lines.push(...item.split(/\r?\n/));
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const url = normalizeTracker(line);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
    if (result.length >= EXTRA_TRACKERS_LIMIT) break;
  }
  return result;
}

/**
 * Appends the popular trackers that are not in `current` yet. The user's own
 * entries stay where they are and the field stays editable: this is a button,
 * not a mode.
 */
export function withPopularTrackers(current: readonly string[]): string[] {
  const existing = new Set(normalizeTrackers([...current]));
  const merged = [...current];
  for (const tracker of POPULAR_TRACKERS) {
    const url = normalizeTracker(tracker);
    if (!url || existing.has(url)) continue;
    existing.add(url);
    merged.push(url);
    if (merged.length >= EXTRA_TRACKERS_LIMIT) break;
  }
  return merged;
}
