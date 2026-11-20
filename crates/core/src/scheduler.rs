//! Queue scheduling: which torrents may run right now.
//!
//! The engine itself only knows "running" and "paused". The queue is layered on
//! top: at most `max_active` unfinished torrents run, the rest are parked in
//! the engine's paused state and reported as [`crate::TorrentState::Queued`].
//! Torrents paused by the user stay paused and never occupy a slot, and a
//! finished torrent leaves the download queue at once (it may keep seeding
//! without a slot), so the next one starts.
//!
//! The queue is a list: the torrent at position `1` downloads first and gets
//! the whole bandwidth. There is no separate numeric priority to compare.

use crate::model::TorrentId;

/// Everything the scheduler needs to know about one torrent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueItem {
    /// Torrent id.
    pub id: TorrentId,
    /// Queue position, `1` = first in the queue (the queue order itself is
    /// kept by [`crate::State::order`]).
    pub position: u32,
    /// Paused explicitly by the user (not by the queue).
    pub user_paused: bool,
    /// All selected files are downloaded.
    pub finished: bool,
    /// The engine reported a fatal error.
    pub errored: bool,
}

/// Result of scheduling one pass over all torrents.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct QueuePlan {
    /// Torrents that may download now, in queue order.
    pub active: Vec<TorrentId>,
    /// Torrents waiting for a slot, best candidate first.
    pub queued: Vec<TorrentId>,
    /// Finished torrents that are not paused: they may seed without a slot.
    pub seeding: Vec<TorrentId>,
    /// Torrents paused by the user explicitly.
    pub paused: Vec<TorrentId>,
}

impl QueuePlan {
    /// Torrent that starts next when a slot frees up.
    pub fn next_to_start(&self) -> Option<TorrentId> {
        self.queued.first().copied()
    }
}

/// Orders queue candidates by queue position.
pub fn sort_for_queue(items: &[QueueItem]) -> Vec<QueueItem> {
    let mut sorted: Vec<QueueItem> = items
        .iter()
        .copied()
        .filter(|i| !i.user_paused && !i.finished && !i.errored)
        .collect();
    sorted.sort_by(|a, b| a.position.cmp(&b.position).then(a.id.cmp(&b.id)));
    sorted
}

/// Computes which torrents run, which wait and which may seed.
///
/// `max_active == 0` means "no limit". Finished torrents are never counted
/// against `max_active`: the download slot goes to the next unfinished torrent
/// in the queue while the finished one may keep seeding.
pub fn plan(items: &[QueueItem], max_active: u32) -> QueuePlan {
    let mut seeding: Vec<TorrentId> = items
        .iter()
        .filter(|i| i.finished && !i.errored && !i.user_paused)
        .map(|i| i.id)
        .collect();
    seeding.sort();

    let mut paused: Vec<TorrentId> = items
        .iter()
        .filter(|i| i.user_paused)
        .map(|i| i.id)
        .collect();
    paused.sort();

    let candidates = sort_for_queue(items);
    let (active, queued): (Vec<TorrentId>, Vec<TorrentId>) = match max_active {
        0 => (candidates.into_iter().map(|i| i.id).collect(), Vec::new()),
        limit => {
            let mut iter = candidates.into_iter();
            let active = iter.by_ref().take(limit as usize).map(|i| i.id).collect();
            let queued = iter.map(|i| i.id).collect();
            (active, queued)
        }
    };

    QueuePlan {
        active,
        queued,
        seeding,
        paused,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: u32, position: u32) -> QueueItem {
        QueueItem {
            id: TorrentId(id),
            position,
            user_paused: false,
            finished: false,
            errored: false,
        }
    }

    #[test]
    fn sorts_by_queue_position() {
        let items = vec![item(5, 3), item(2, 1), item(1, 4), item(9, 2)];
        let order: Vec<u32> = sort_for_queue(&items).iter().map(|i| i.id.0).collect();
        assert_eq!(order, vec![2, 9, 5, 1]);
    }

    #[test]
    fn active_is_limited_and_rest_wait_in_order() {
        let items = vec![item(0, 3), item(1, 1), item(2, 2), item(3, 4)];
        let plan = plan(&items, 2);
        assert_eq!(plan.active, vec![TorrentId(1), TorrentId(2)]);
        assert_eq!(plan.queued, vec![TorrentId(0), TorrentId(3)]);
        assert_eq!(plan.next_to_start(), Some(TorrentId(0)));
    }

    #[test]
    fn single_slot_takes_strictly_the_top_of_the_queue() {
        let items = vec![item(0, 2), item(1, 1), item(2, 3)];
        let first = plan(&items, 1);
        assert_eq!(first.active, vec![TorrentId(1)]);
        assert_eq!(first.queued, vec![TorrentId(0), TorrentId(2)]);

        // Moving another torrent to position 1 hands the slot over at once.
        let moved = vec![item(0, 2), item(1, 3), item(2, 1)];
        let after_move = plan(&moved, 1);
        assert_eq!(after_move.active, vec![TorrentId(2)]);
        assert_eq!(after_move.queued, vec![TorrentId(0), TorrentId(1)]);
    }

    #[test]
    fn zero_max_active_means_unlimited() {
        let items = vec![item(0, 3), item(1, 1), item(2, 2)];
        let plan = plan(&items, 0);
        assert_eq!(plan.active.len(), 3);
        assert!(plan.queued.is_empty());
    }

    #[test]
    fn finished_torrent_frees_its_slot_for_the_next_in_queue() {
        let mut items = vec![item(0, 1), item(1, 2), item(2, 3), item(3, 4)];
        let first = plan(&items, 2);
        assert_eq!(first.active, vec![TorrentId(0), TorrentId(1)]);

        // The top torrent completes: its download slot goes to position 3.
        items[0].finished = true;
        let after = plan(&items, 2);
        assert_eq!(after.active, vec![TorrentId(1), TorrentId(2)]);
        assert_eq!(after.queued, vec![TorrentId(3)]);
        assert_eq!(after.next_to_start(), Some(TorrentId(3)));
        assert_eq!(after.seeding, vec![TorrentId(0)]);
    }

    #[test]
    fn finished_top_frees_the_only_slot() {
        let mut items = vec![item(0, 1), item(1, 2)];
        items[0].finished = true;
        let plan = plan(&items, 1);
        assert_eq!(plan.active, vec![TorrentId(1)]);
        assert!(plan.queued.is_empty());
        assert_eq!(plan.seeding, vec![TorrentId(0)]);
    }

    #[test]
    fn paused_and_errored_are_not_scheduled() {
        let items = vec![
            QueueItem {
                user_paused: true,
                ..item(0, 1)
            },
            QueueItem {
                errored: true,
                ..item(1, 2)
            },
            item(2, 3),
        ];
        let plan = plan(&items, 1);
        assert_eq!(plan.active, vec![TorrentId(2)]);
        assert!(plan.queued.is_empty());
        assert!(plan.seeding.is_empty());
        assert_eq!(plan.paused, vec![TorrentId(0)]);
    }
}
