//! Watching The Index for changes made outside Envy.
//!
//! Port of `NoteStore.startWatching()`, which uses FSEvents on macOS. The
//! reason it uses FSEvents rather than a per-directory file descriptor is
//! worth restating, because the equivalent trap exists here: watching a
//! directory only reports its *entry list* changing — a file added, removed,
//! or renamed — and stays silent when an existing file's contents are
//! overwritten in place. Another app editing a note is exactly the case this
//! needs to catch, so the watch has to report individual file modifications.
//! `notify`'s Windows backend (ReadDirectoryChangesW) does this natively with
//! a recursive watch.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};

/// How long to wait for a burst of changes to settle before reporting one.
///
/// The Mac uses 400ms for the same job. Bursts are the normal case, not the
/// exception: a sync client landing a batch, a `git pull`, a bulk import. Each
/// callback would otherwise kick off a full folder rescan, and with a few
/// thousand notes that is a real read-every-file pass.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// Keeps the watch alive. Dropping this stops it.
pub struct IndexWatcher {
    _watcher: notify::RecommendedWatcher,
}

/// Whether an event means the *content or existence* of a note changed, as
/// opposed to metadata churn.
///
/// The Mac filters FSEvents down to created/removed/renamed/modified because
/// Spotlight writes extended attributes while indexing a batch of new files,
/// which arrives as a flood of file-changed events indistinguishable from real
/// edits — a bulk import was seen producing dozens over ~20 seconds after the
/// writes had finished, each triggering a full reload.
///
/// Windows has the same problem from different sources: the Search Indexer and
/// on-access antivirus scanners both touch files they inspect. The filtering
/// is not a transcription of the Mac's flag check, because `notify`'s event
/// model is not FSEvents' — here it's `EventKind`, and the one to exclude is
/// `Modify(Metadata)`, which is what an attribute or last-access-time write
/// arrives as.
fn is_meaningful(kind: &EventKind) -> bool {
    use notify::event::{ModifyKind, RenameMode};
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => true,
        EventKind::Modify(ModifyKind::Data(_)) => true,
        EventKind::Modify(ModifyKind::Name(RenameMode::Any | RenameMode::Both | RenameMode::To | RenameMode::From)) => true,
        // Deliberately excluded: Modify(Metadata) — attribute and timestamp
        // writes, which indexers and scanners generate in volume.
        EventKind::Modify(ModifyKind::Metadata(_)) => false,
        // `Any` is what the Windows backend falls back to when it cannot
        // classify a change. Treating it as meaningful is the safe direction:
        // a redundant reload costs a rescan, a missed one loses an edit.
        EventKind::Modify(ModifyKind::Any) | EventKind::Any => true,
        _ => false,
    }
}

/// Only `.md` files matter, and only outside `.trash`. A file landing in trash
/// is always Envy's own doing — the delete that put it there has already
/// updated the store, so reacting to it would just cause a redundant rescan.
fn is_relevant_path(path: &Path) -> bool {
    let is_md = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !is_md {
        // A directory being created or renamed still matters — a whole folder
        // of notes can arrive at once.
        return path.extension().is_none();
    }
    !path
        .components()
        .any(|c| c.as_os_str() == crate::store::TRASH_FOLDER_NAME)
}

/// Watches `directory` recursively, calling `on_change` once per settled burst.
///
/// `on_change` runs on the watcher's own thread, not the caller's.
pub fn watch<F>(directory: &Path, on_change: F) -> notify::Result<IndexWatcher>
where
    F: Fn() + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<()>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !is_meaningful(&event.kind) {
            return;
        }
        if !event.paths.iter().any(|p| is_relevant_path(p)) {
            return;
        }
        // Ignore a closed receiver: it just means the watcher outlived the
        // debounce thread during shutdown.
        let _ = tx.send(());
    })?;
    watcher.watch(directory, RecursiveMode::Recursive)?;

    // Coalesce: block for the next event, then keep draining until the channel
    // stays quiet for DEBOUNCE before reporting once.
    thread::spawn(move || {
        while rx.recv().is_ok() {
            while rx.recv_timeout(DEBOUNCE).is_ok() {}
            on_change();
        }
    });

    Ok(IndexWatcher { _watcher: watcher })
}

/// Convenience for callers that only have an owned path.
pub fn watch_path<F>(directory: PathBuf, on_change: F) -> notify::Result<IndexWatcher>
where
    F: Fn() + Send + 'static,
{
    watch(&directory, on_change)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, MetadataKind, ModifyKind};

    #[test]
    fn metadata_writes_are_ignored() {
        // What an indexer or antivirus scanner produces.
        assert!(!is_meaningful(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::Any
        ))));
        assert!(!is_meaningful(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::AccessTime
        ))));
    }

    #[test]
    fn content_and_existence_changes_are_meaningful() {
        assert!(is_meaningful(&EventKind::Create(
            notify::event::CreateKind::File
        )));
        assert!(is_meaningful(&EventKind::Remove(
            notify::event::RemoveKind::File
        )));
        assert!(is_meaningful(&EventKind::Modify(ModifyKind::Data(
            DataChange::Content
        ))));
    }

    /// The Windows backend reports unclassifiable changes as `Any`. Erring
    /// toward reloading is the safe direction.
    #[test]
    fn unclassified_changes_are_treated_as_meaningful() {
        assert!(is_meaningful(&EventKind::Modify(ModifyKind::Any)));
        assert!(is_meaningful(&EventKind::Any));
    }

    #[test]
    fn only_markdown_and_directories_are_relevant() {
        assert!(is_relevant_path(Path::new("C:/Index/Note.md")));
        assert!(is_relevant_path(Path::new("C:/Index/Note.MD")));
        assert!(is_relevant_path(Path::new("C:/Index/Projects"))); // directory
        assert!(!is_relevant_path(Path::new("C:/Index/image.png")));
    }

    /// A file landing in trash is always Envy's own delete, which has already
    /// updated the store.
    #[test]
    fn trashed_files_are_ignored() {
        assert!(!is_relevant_path(Path::new("C:/Index/.trash/Note.md")));
        assert!(!is_relevant_path(Path::new("C:/Index/Sub/.trash/Note.md")));
    }
}
