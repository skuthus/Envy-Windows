//! The note model and store — the platform-agnostic half of Envy.
//!
//! This is a port of `Sources/EnvyCore` from the macOS app
//! (<https://github.com/skuthus/Envy>), which was already written to be
//! platform-agnostic. Where the original carries a comment explaining *why*
//! something is the way it is — a performance measurement, a bug that a
//! simpler shape caused, a deliberate partial implementation — that reasoning
//! is preserved rather than rediscovered.
//!
//! The rule this crate follows: **behavior must match the Mac build exactly.**
//! Notes are plain `.md` files that a person may well sync between the two,
//! and a note that means one thing on one platform and something else on the
//! other is a data bug, not a cosmetic difference. Where the Mac behavior is
//! arguably wrong but harmless, it is reproduced and documented rather than
//! quietly corrected — see `due::parse_flexible_date`.

pub mod due;
pub mod filename;
pub mod interlinks;
pub mod note;
pub mod search;
pub mod store;
pub mod watcher;

pub use due::{resolve_due_token, urgency_for, DueUrgency};
pub use interlinks::{interlinks_for, InterlinkRef, Interlinks, Suggestion};
pub use note::{AiProvenance, Note, ParsedWikiLink, WikiLink};
pub use search::{filtered, SearchContext};
pub use store::{subfolder_path, NoteStore, NoteTemplate};
pub use watcher::{watch_path, IndexWatcher};
