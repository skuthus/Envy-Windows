//! Port of `NoteStore.swift`'s folder scan and CRUD.
//!
//! The Index is one folder. Singular by design: Envy used to support several
//! folders merged into one list, but that flexibility mostly bought confusion
//! (which folder does a new note land in, what does "move to folder" mean,
//! does a search span all of them) for a feature almost nobody used across
//! more than one.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rayon::prelude::*;

use crate::filename::{available_path, sanitize_title, unique_filename};
use crate::note::Note;
use crate::search::INBOX_FOLDER_NAME;

pub const TEMPLATES_FOLDER_NAME: &str = "Templates";

/// A folder's own `.trash` subfolder is where `delete` sends notes first,
/// ahead of the real Recycle Bin — not one `Trash/` at the Index's top level,
/// but one hidden `.trash` sibling per folder a note actually lives in. That's
/// what makes restore trivial: a trashed note's parent folder always *is* the
/// folder it came from, so no "original location" bookkeeping is needed and it
/// survives app restarts for free. Being dot-prefixed also means it's never
/// scanned, and it can never collide with a real folder the user named
/// "Trash".
pub const TRASH_FOLDER_NAME: &str = ".trash";

/// A template is a plain `.md` file in the Index's `Templates/` subfolder —
/// never a `Note`. The scan skips descending into `Templates/` even when
/// subfolders are included, so templates are never visible to
/// search/list/backlinks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteTemplate {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

pub struct NoteStore {
    directory: PathBuf,
    include_subfolders: bool,
    notes: Vec<Note>,
    trashed: Vec<Note>,
    /// The most recently deleted note(s). A single delete or a whole bulk
    /// delete counts as one action for undo, so this holds everything from the
    /// last `delete` call together — not a full history stack. Replaced (not
    /// appended to) by the next delete, and cleared once restored.
    last_deleted: Vec<(Note, PathBuf)>,
}

impl NoteStore {
    pub fn open(directory: impl Into<PathBuf>, include_subfolders: bool) -> std::io::Result<Self> {
        let directory = directory.into();
        fs::create_dir_all(&directory)?;
        // Resolved once, so every note's id/path and any future watch agree on
        // one path form.
        let directory = dunce::canonicalize(&directory).unwrap_or(directory);
        let mut store = Self {
            directory,
            include_subfolders,
            notes: Vec::new(),
            trashed: Vec::new(),
            last_deleted: Vec::new(),
        };
        store.reload();
        Ok(store)
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn notes(&self) -> &[Note] {
        &self.notes
    }

    pub fn trashed_notes(&self) -> &[Note] {
        &self.trashed
    }

    pub fn can_restore_last_deleted(&self) -> bool {
        !self.last_deleted.is_empty()
    }

    pub fn set_include_subfolders(&mut self, include: bool) {
        if include == self.include_subfolders {
            return;
        }
        self.include_subfolders = include;
        self.reload();
    }

    pub fn reload(&mut self) {
        self.notes = scan_directory(&self.directory, self.include_subfolders);
        self.refresh_trashed();
    }

    fn refresh_trashed(&mut self) {
        self.trashed = scan_trashed_notes(&self.directory);
    }

    // --- CRUD ---------------------------------------------------------------

    pub fn create(&mut self, title: &str) -> std::io::Result<Note> {
        self.create_in(title, self.directory.clone())
    }

    /// Captures a fleeting note. Creates `Inbox/` on demand, so the feature
    /// works without anyone making the folder by hand first.
    pub fn create_inbox_note(&mut self, title: &str) -> std::io::Result<Note> {
        let dir = self.directory.join(INBOX_FOLDER_NAME);
        fs::create_dir_all(&dir)?;
        self.create_in(title, dir)
    }

    fn create_in(&mut self, title: &str, dir: PathBuf) -> std::io::Result<Note> {
        let path = dir.join(unique_filename(title, &dir));
        fs::write(&path, "")?;
        let note = Note::new(path, "", SystemTime::now());
        self.notes.insert(0, note.clone());
        Ok(note)
    }

    /// The note whose title matches `query` exactly, case-insensitively —
    /// the same comparison `Note::wiki_links` lowercases its targets with, so
    /// a link resolves here exactly when it registers as a backlink there.
    pub fn exact_title_match(&self, query: &str) -> Option<&Note> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return None;
        }
        self.notes.iter().find(|n| n.lowercased_title() == q)
    }

    /// Follows a `[[wiki-link]]`: returns the note it points at, creating it if
    /// it doesn't exist yet.
    ///
    /// A link-created note always lands in the Index proper, never `Inbox/`,
    /// even when "new notes start in the Inbox" is on — the same carve-out the
    /// Mac makes for links and templates alike. Both are *already placed*: you
    /// said where this note belongs by linking to it from somewhere, so
    /// routing it through a capture queue would be asking a question you've
    /// already answered.
    pub fn open_or_create_link(&mut self, target: &str) -> std::io::Result<Note> {
        if let Some(found) = self.exact_title_match(target) {
            return Ok(found.clone());
        }
        let dir = self.directory.clone();
        self.create_in(target, dir)
    }

    pub fn save(&mut self, note: &Note) -> std::io::Result<()> {
        fs::write(note.url(), note.content())?;
        if let Some(existing) = self.notes.iter_mut().find(|n| n.id() == note.id()) {
            existing.set_content(note.content());
            existing.modified = SystemTime::now();
        }
        Ok(())
    }

    /// Renames a note and rewrites every `[[link]]` and `![[embed]]` pointing
    /// at it across the Index, so nothing breaks.
    pub fn rename(&mut self, note: &Note, new_title: &str) -> std::io::Result<Note> {
        let trimmed = new_title.trim();
        if trimmed.is_empty() || trimmed == note.title() {
            return Ok(note.clone());
        }
        let dir = note.url().parent().unwrap_or(&self.directory).to_path_buf();

        // A case-only change ("test" → "Test") collides with the file itself
        // on a case-insensitive volume, so asking for a free name would hand
        // back "Test 2". Move straight to the new spelling instead.
        let new_path = if trimmed.eq_ignore_ascii_case(note.title()) {
            dir.join(format!("{}.md", sanitize_title(trimmed)))
        } else {
            dir.join(unique_filename(trimmed, &dir))
        };

        fs::rename(note.url(), &new_path)?;
        let renamed = Note::new(new_path, note.content(), SystemTime::now());
        if let Some(slot) = self.notes.iter_mut().find(|n| n.id() == note.id()) {
            *slot = renamed.clone();
        }
        self.update_wiki_link_references(note.title(), renamed.title());
        Ok(renamed)
    }

    /// After a rename, rewrite every `[[old]]` / `![[old]]` reference to point
    /// at the new title. Matching is case-insensitive (the same way a
    /// wiki-link resolves) and an embed's leading `!` is preserved.
    ///
    /// A reference-only rewrite **keeps each note's modified date**, both in
    /// memory and on disk, so renaming a widely-linked note doesn't shove all
    /// its referrers to the top of a date-sorted list — the user renamed one
    /// note, they didn't edit thirty others.
    fn update_wiki_link_references(&mut self, old_title: &str, new_title: &str) {
        if old_title.eq_ignore_ascii_case(new_title) {
            return;
        }
        let old_lower = old_title.to_lowercase();
        // Group 2 captures any alias or heading suffix so it survives the
        // rewrite: `[[Old|yesterday's notes]]` becomes `[[New|yesterday's
        // notes]]`, not `[[New]]`. Without it a rename would silently discard
        // the words the author actually wrote into their sentence.
        let pattern = format!(
            r"(?i)(!?)\[\[[ \t]*{}[ \t]*((?:#|\|)[^\[\]]*)?\]\]",
            fancy_regex::escape(old_title)
        );
        let Ok(re) = fancy_regex::Regex::new(&pattern) else {
            return;
        };
        let replacement = format!("${{1}}[[{new_title}${{2}}]]");

        // Candidates come from the wiki-links cache, so only notes that
        // actually reference the old title are touched.
        let ids: Vec<String> = self
            .notes
            .iter()
            .filter(|n| n.wiki_links().contains(&old_lower))
            .map(|n| n.id().to_string())
            .collect();

        for id in ids {
            let Some(idx) = self.notes.iter().position(|n| n.id() == id) else {
                continue;
            };
            let content = self.notes[idx].content().to_string();
            let updated = re.replace_all(&content, replacement.as_str()).into_owned();
            if updated == content {
                continue;
            }
            let path = self.notes[idx].url().to_path_buf();
            let original_modified = self.notes[idx].modified;
            if fs::write(&path, &updated).is_err() {
                continue;
            }
            // Restore the modification time the rewrite just clobbered.
            let _ = set_modified(&path, original_modified);
            self.notes[idx].set_content(updated);
            self.notes[idx].modified = original_modified;
        }
    }

    pub fn delete(&mut self, notes_to_delete: &[Note]) {
        if notes_to_delete.is_empty() {
            return;
        }
        let mut trashed = Vec::new();
        for note in notes_to_delete {
            let Some(parent) = note.url().parent() else {
                continue;
            };
            let trash_dir = parent.join(TRASH_FOLDER_NAME);
            if fs::create_dir_all(&trash_dir).is_err() {
                continue;
            }
            let destination = trash_dir.join(unique_filename(note.title(), &trash_dir));
            if fs::rename(note.url(), &destination).is_ok() {
                trashed.push((note.clone(), destination));
            }
        }
        let deleted_ids: Vec<&str> = notes_to_delete.iter().map(|n| n.id()).collect();
        self.notes.retain(|n| !deleted_ids.contains(&n.id()));
        self.last_deleted = trashed;
        self.refresh_trashed();
    }

    /// Moves the most recently deleted note(s) back out of `.trash` to their
    /// original location. A note whose original location has since been reused
    /// — a new note created with the same filename — is silently skipped
    /// rather than overwriting it or failing loudly.
    pub fn restore_last_deleted(&mut self) -> Vec<Note> {
        if self.last_deleted.is_empty() {
            return Vec::new();
        }
        let mut restored = Vec::new();
        for (note, trashed_path) in std::mem::take(&mut self.last_deleted) {
            if note.url().exists() {
                continue;
            }
            if fs::rename(&trashed_path, note.url()).is_ok() {
                restored.push(note);
            }
        }
        self.notes.extend(restored.iter().cloned());
        self.refresh_trashed();
        restored
    }

    /// Restores an arbitrary trashed note — unlike `restore_last_deleted`,
    /// which only remembers the most recent delete and only for this process,
    /// this works for anything currently in any `.trash` subfolder.
    pub fn restore_from_trash(&mut self, note: &Note) -> Option<Note> {
        let trash_dir = note.url().parent()?;
        let original_dir = trash_dir.parent()?;
        let destination = available_path(note.title(), original_dir);
        fs::rename(note.url(), &destination).ok()?;
        let restored = Note::new(destination, note.content(), note.modified);
        self.notes.push(restored.clone());
        self.refresh_trashed();
        Some(restored)
    }

    pub fn delete_from_trash(&mut self, note: &Note) {
        let _ = fs::remove_file(note.url());
        self.refresh_trashed();
    }

    pub fn empty_trash(&mut self) {
        for dir in all_trash_directories(&self.directory) {
            let _ = fs::remove_dir_all(&dir);
        }
        self.refresh_trashed();
    }

    // --- Templates ----------------------------------------------------------

    pub fn templates(&self) -> Vec<NoteTemplate> {
        let dir = self.directory.join(TEMPLATES_FOLDER_NAME);
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut out: Vec<NoteTemplate> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| is_markdown(p))
            .map(|path| NoteTemplate {
                id: path.to_string_lossy().into_owned(),
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path,
            })
            .collect();
        out.sort_by_key(|t| t.name.to_lowercase());
        out
    }

    /// Creates a note from a template, substituting the template tokens.
    ///
    /// `date_text` is caller-formatted rather than decided here, so the app's
    /// own date-format setting applies — this crate stays UI-agnostic and
    /// doesn't own a preferred date style.
    ///
    /// The *title* is substituted too, before it's used, so a template named
    /// "Daily Notes {{date}}" produces a note titled with today's actual date
    /// rather than the literal token. An empty title falls back to the
    /// template's own name.
    pub fn create_from_template(
        &mut self,
        title: &str,
        template: &NoteTemplate,
        date_text: &str,
        time_text: &str,
    ) -> std::io::Result<Note> {
        let trimmed = title.trim();
        let raw_base = if trimmed.is_empty() { &template.name } else { trimmed };
        let base = apply_template_tokens(raw_base, raw_base, date_text, time_text);

        let path = self.directory.join(unique_filename(&base, &self.directory));
        let raw = fs::read_to_string(&template.path).unwrap_or_default();
        let content = apply_template_tokens(&raw, &base, date_text, time_text);

        fs::write(&path, &content)?;
        let note = Note::new(path, content, SystemTime::now());
        self.notes.insert(0, note.clone());
        Ok(note)
    }

    /// Turns a note into a template — a plain move into `Templates/`, which
    /// drops it out of `notes` since the scan never treats that folder as
    /// notes. The text is untouched: a template is just a note that lives
    /// somewhere else.
    pub fn convert_to_template(&mut self, note: &Note) -> Option<NoteTemplate> {
        let dir = self.directory.join(TEMPLATES_FOLDER_NAME);
        fs::create_dir_all(&dir).ok()?;
        let path = dir.join(unique_filename(note.title(), &dir));
        fs::rename(note.url(), &path).ok()?;
        self.notes.retain(|n| n.id() != note.id());
        Some(NoteTemplate {
            id: path.to_string_lossy().into_owned(),
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path,
        })
    }

    /// Files a fleeting note into the Index proper — a plain move out of
    /// `Inbox/`. The note's text is untouched, so nothing about having been
    /// fleeting survives in the file.
    pub fn submit_from_inbox(&mut self, note: &Note) -> Option<Note> {
        if !crate::search::is_inbox_note(note) {
            return None;
        }
        let destination = available_path(note.title(), &self.directory);
        fs::rename(note.url(), &destination).ok()?;
        let moved = Note::new(destination, note.content(), note.modified);
        if let Some(slot) = self.notes.iter_mut().find(|n| n.id() == note.id()) {
            *slot = moved.clone();
        }
        Some(moved)
    }
}

/// A small fixed set of tokens — plain string replacement, not any kind of
/// scripting, so a template stays a plain markdown file readable by any other
/// editor too.
fn apply_template_tokens(text: &str, title: &str, date_text: &str, time_text: &str) -> String {
    text.replace("{{date}}", date_text)
        .replace("{{time}}", time_text)
        .replace("{{title}}", title)
}

fn is_markdown(p: &Path) -> bool {
    p.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

fn is_hidden(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

fn set_modified(path: &Path, time: SystemTime) -> std::io::Result<()> {
    let f = fs::OpenOptions::new().write(true).open(path)?;
    f.set_modified(time)
}

/// Every `.md` file to treat as a note.
///
/// `Templates/` is skipped whether or not subfolder scanning is on — templates
/// are never notes. Hidden directories are skipped wholesale, which is what
/// keeps `.trash` invisible without needing its own special case (the same
/// property `skipsHiddenFiles` provides on the Mac).
///
/// `Inbox/` is read even when subfolder scanning is off: it isn't a folder the
/// user made to organise things, it's where captures land, and a fleeting note
/// that only appears if an unrelated setting happens to be enabled is a lost
/// note.
/// Returns each note's modification time alongside its path, taken from the
/// directory entry rather than looked up afterwards.
///
/// This matters more on Windows than the shape of the code suggests. Windows'
/// directory enumeration returns full metadata for every entry as part of the
/// listing, and `DirEntry::file_type`/`DirEntry::metadata` read it straight out
/// of that already-fetched record without touching the disk again. Calling
/// `Path::is_dir()` or `fs::metadata(&path)` instead throws that away and opens
/// the file by path a second time — and a path-based open on Windows is far
/// more expensive than the equivalent `stat` on macOS, because it walks and
/// re-resolves every component of the path.
///
/// Doing it the naive way cost two extra opens per note (one to test whether
/// the entry was a directory, one for the modification date), so scanning
/// 5,000 notes paid 15,000 file opens rather than 5,000. That is the whole
/// reason a reload here was slower than the Mac's, which gets the same data for
/// free by asking for `.contentModificationDateKey` during enumeration.
fn note_paths(directory: &Path, include_subfolders: bool) -> Vec<(PathBuf, SystemTime)> {
    let templates = directory.join(TEMPLATES_FOLDER_NAME);
    let mut out = Vec::new();

    fn walk(
        dir: &Path,
        templates: &Path,
        recurse: bool,
        out: &mut Vec<(PathBuf, SystemTime)>,
    ) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            // A symlink's own file_type says "symlink", not what it points at,
            // so fall back to the path-based test for those alone — the Mac
            // resolves symlinks here too, and they're rare enough that the
            // extra syscall doesn't matter.
            let is_dir = match entry.file_type() {
                Ok(t) if t.is_symlink() => path.is_dir(),
                Ok(t) => t.is_dir(),
                Err(_) => path.is_dir(),
            };
            if is_dir {
                if !recurse || is_hidden(&path) || path == templates {
                    continue;
                }
                walk(&path, templates, true, out);
            } else if is_markdown(&path) && !is_hidden(&path) {
                let modified = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or_else(|_| SystemTime::now());
                out.push((path, modified));
            }
        }
    }

    walk(directory, &templates, include_subfolders, &mut out);

    if !include_subfolders {
        let inbox = directory.join(INBOX_FOLDER_NAME);
        if inbox.is_dir() {
            walk(&inbox, &templates, false, &mut out);
        }
    }
    out
}

/// Reads every note under `directory`, newest first.
///
/// Reading each file is its own syscall, and doing that serially means paying
/// each file's latency in turn — measured on the Mac as the dominant cost of a
/// reload with several thousand notes (over a second for 10,000 files on a
/// fast local disk). `rayon` reads them across the available cores instead,
/// which is what `DispatchQueue.concurrentPerform` does there.
pub fn scan_directory(directory: &Path, include_subfolders: bool) -> Vec<Note> {
    let paths = note_paths(directory, include_subfolders);
    let mut notes: Vec<Note> = paths
        .into_par_iter()
        .filter_map(|(path, modified)| {
            let content = fs::read_to_string(&path).ok()?;
            Some(Note::new(path, content, modified))
        })
        .collect();
    notes.sort_by_key(|n| std::cmp::Reverse(n.modified));
    notes
}

/// Every `.trash` directory anywhere under `directory` — there's one per
/// folder that's ever had a note deleted from it, not just one at the top.
fn all_trash_directories(directory: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path.file_name().is_some_and(|n| n == TRASH_FOLDER_NAME) {
                out.push(path); // don't descend into trash
            } else {
                walk(&path, out);
            }
        }
    }
    walk(directory, &mut out);
    out
}

/// Not parallelised like `scan_directory`: trash holds far fewer notes than
/// the whole Index at any given time, so a plain sequential scan is simpler
/// and in practice just as fast.
pub fn scan_trashed_notes(directory: &Path) -> Vec<Note> {
    let mut out = Vec::new();
    for trash_dir in all_trash_directories(directory) {
        let Ok(entries) = fs::read_dir(&trash_dir) else {
            continue;
        };
        for path in entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| is_markdown(p))
        {
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let modified = fs::metadata(&path)
                .and_then(|m| m.modified())
                .unwrap_or_else(|_| SystemTime::now());
            out.push(Note::new(path, content, modified));
        }
    }
    out.sort_by_key(|n| std::cmp::Reverse(n.modified));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tempfile::TempDir;

    fn store_with(files: &[(&str, &str)]) -> (TempDir, NoteStore) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, content) in files {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
        }
        let store = NoteStore::open(dir.path(), false).unwrap();
        (dir, store)
    }

    fn titles(store: &NoteStore) -> Vec<String> {
        let mut t: Vec<String> = store.notes().iter().map(|n| n.title().to_string()).collect();
        t.sort();
        t
    }

    // --- Scanning -----------------------------------------------------------

    #[test]
    fn scan_reads_markdown_and_ignores_everything_else() {
        let (_d, store) = store_with(&[
            ("One.md", "first"),
            ("Two.md", "second"),
            ("notes.txt", "not a note"),
            ("image.png", "not a note"),
        ]);
        assert_eq!(titles(&store), vec!["One", "Two"]);
    }

    #[test]
    fn templates_are_never_notes() {
        let (_d, store) = store_with(&[("Real.md", "x"), ("Templates/Daily.md", "y")]);
        assert_eq!(titles(&store), vec!["Real"]);
        assert_eq!(store.templates().len(), 1);
        assert_eq!(store.templates()[0].name, "Daily");
    }

    #[test]
    fn trash_is_invisible_to_the_scan() {
        let (_d, store) = store_with(&[("Real.md", "x"), (".trash/Deleted.md", "y")]);
        assert_eq!(titles(&store), vec!["Real"]);
        // But it is visible as trash.
        assert_eq!(store.trashed_notes().len(), 1);
    }

    /// Inbox is read even with subfolder scanning off — a fleeting note that
    /// only appears when an unrelated setting is enabled is a lost note.
    #[test]
    fn inbox_is_read_even_when_subfolders_are_off() {
        let (_d, store) = store_with(&[("Filed.md", "x"), ("Inbox/Fleeting.md", "y")]);
        assert_eq!(titles(&store), vec!["Filed", "Fleeting"]);
    }

    #[test]
    fn other_subfolders_are_skipped_unless_enabled() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Projects")).unwrap();
        fs::write(dir.path().join("Top.md"), "x").unwrap();
        fs::write(dir.path().join("Projects/Nested.md"), "y").unwrap();

        let flat = NoteStore::open(dir.path(), false).unwrap();
        assert_eq!(titles(&flat), vec!["Top"]);

        let deep = NoteStore::open(dir.path(), true).unwrap();
        assert_eq!(titles(&deep), vec!["Nested", "Top"]);
    }

    // --- CRUD ---------------------------------------------------------------

    #[test]
    fn create_makes_a_file_and_disambiguates() {
        let (dir, mut store) = store_with(&[]);
        let a = store.create("Ideas").unwrap();
        assert_eq!(a.title(), "Ideas");
        assert!(dir.path().join("Ideas.md").exists());

        let b = store.create("Ideas").unwrap();
        assert_eq!(b.title(), "Ideas 2");
    }

    #[test]
    fn create_sanitizes_a_windows_illegal_title() {
        let (dir, mut store) = store_with(&[]);
        // Legal on macOS, impossible on Windows.
        let note = store.create("What? *now*").unwrap();
        assert_eq!(note.title(), "What- -now-");
        assert!(dir.path().join("What- -now-.md").exists());
    }

    #[test]
    fn save_writes_content_to_disk() {
        let (dir, mut store) = store_with(&[("A.md", "old")]);
        let mut note = store.notes()[0].clone();
        note.set_content("new");
        store.save(&note).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("A.md")).unwrap(), "new");
        assert_eq!(store.notes()[0].content(), "new");
    }

    /// Every derived value is cached per `(url, content)` pair, so a save has
    /// to leave the stored note with a *fresh* cache or the list keeps
    /// reporting the old due date, tags and badges forever. Removing a due
    /// token is the case that fails most visibly — the pill outlives the text
    /// that justified it.
    #[test]
    fn saving_recomputes_derived_values() {
        let (_d, mut store) = store_with(&[("A.md", "ship it @01-05-26 #alpha")]);
        let jan5 = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
        assert_eq!(store.notes()[0].due(), Some(jan5));
        assert!(store.notes()[0].tags().contains("alpha"));

        // Change the date.
        let mut note = store.notes()[0].clone();
        note.set_content("ship it @02-09-26 #beta");
        store.save(&note).unwrap();
        assert_eq!(
            store.notes()[0].due(),
            Some(NaiveDate::from_ymd_opt(2026, 2, 9).unwrap())
        );
        assert!(store.notes()[0].tags().contains("beta"));
        assert!(!store.notes()[0].tags().contains("alpha"));

        // Remove it entirely.
        let mut note = store.notes()[0].clone();
        note.set_content("ship it, no date now");
        store.save(&note).unwrap();
        assert_eq!(store.notes()[0].due(), None);
        assert_eq!(store.notes()[0].due_date_count(), 0);
        assert!(store.notes()[0].tags().is_empty());
    }

    // --- Rename and link rewriting -----------------------------------------

    #[test]
    fn rename_moves_the_file() {
        let (dir, mut store) = store_with(&[("Old.md", "body")]);
        let note = store.notes()[0].clone();
        let renamed = store.rename(&note, "New").unwrap();
        assert_eq!(renamed.title(), "New");
        assert!(dir.path().join("New.md").exists());
        assert!(!dir.path().join("Old.md").exists());
    }

    #[test]
    fn rename_rewrites_links_and_embeds_across_the_index() {
        let (dir, mut store) = store_with(&[
            ("Old.md", "target"),
            ("Ref.md", "see [[Old]] and embed ![[Old]]"),
        ]);
        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Old")
            .unwrap()
            .clone();
        store.rename(&note, "New").unwrap();

        let rewritten = fs::read_to_string(dir.path().join("Ref.md")).unwrap();
        assert_eq!(rewritten, "see [[New]] and embed ![[New]]");
    }

    /// `[[Old|yesterday's notes]]` must become `[[New|yesterday's notes]]`,
    /// not `[[New]]` — otherwise a rename silently discards the words the
    /// author wrote into their sentence.
    #[test]
    fn rename_preserves_aliases_and_heading_refs() {
        let (dir, mut store) = store_with(&[
            ("Old.md", "target"),
            ("Ref.md", "[[Old|yesterday's notes]] and [[Old#Agenda]]"),
        ]);
        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Old")
            .unwrap()
            .clone();
        store.rename(&note, "New").unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("Ref.md")).unwrap(),
            "[[New|yesterday's notes]] and [[New#Agenda]]"
        );
    }

    #[test]
    fn rename_matches_links_case_insensitively() {
        let (dir, mut store) = store_with(&[("Old.md", "t"), ("Ref.md", "see [[old]]")]);
        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Old")
            .unwrap()
            .clone();
        store.rename(&note, "New").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("Ref.md")).unwrap(),
            "see [[New]]"
        );
    }

    /// The user renamed one note; they didn't edit thirty others. A
    /// reference-only rewrite must keep each referrer's modified date, or
    /// renaming a widely-linked note shoves every referrer to the top of a
    /// date-sorted list.
    #[test]
    fn rewriting_a_reference_does_not_bump_the_referrers_modified_date() {
        let (_d, mut store) = store_with(&[("Old.md", "t"), ("Ref.md", "see [[Old]]")]);
        let before = store
            .notes()
            .iter()
            .find(|n| n.title() == "Ref")
            .unwrap()
            .modified;

        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Old")
            .unwrap()
            .clone();
        store.rename(&note, "New").unwrap();

        let after = store
            .notes()
            .iter()
            .find(|n| n.title() == "Ref")
            .unwrap()
            .modified;
        assert_eq!(before, after);
    }

    #[test]
    fn case_only_rename_does_not_disambiguate_into_a_new_name() {
        let (dir, mut store) = store_with(&[("test.md", "x")]);
        let note = store.notes()[0].clone();
        let renamed = store.rename(&note, "Test").unwrap();
        // Not "Test 2" — the collision is with the file itself.
        assert_eq!(renamed.title(), "Test");
        assert!(dir.path().join("Test.md").exists());
    }

    #[test]
    fn creating_from_a_template_substitutes_tokens() {
        let (dir, mut store) = store_with(&[(
            "Templates/Daily.md",
            "# {{title}}\n\nWritten {{date}} at {{time}}.\n",
        )]);
        let template = store.templates()[0].clone();

        let note = store
            .create_from_template("Monday", &template, "2026-07-25", "9:30 AM")
            .unwrap();

        assert_eq!(note.title(), "Monday");
        assert_eq!(note.content(), "# Monday\n\nWritten 2026-07-25 at 9:30 AM.\n");
        assert!(dir.path().join("Monday.md").exists());
        // It lands in the Index, not in Templates/.
        assert!(!dir.path().join("Templates/Monday.md").exists());
    }

    /// An empty title falls back to the template's own name — and the *title*
    /// is substituted before use, so a template called "Daily {{date}}"
    /// produces a note named for today rather than the literal token.
    #[test]
    fn an_untitled_note_takes_the_templates_name_with_tokens_resolved() {
        let (dir, mut store) = store_with(&[("Templates/Daily {{date}}.md", "body {{title}}")]);
        let template = store.templates()[0].clone();

        let note = store
            .create_from_template("", &template, "2026-07-25", "9:30 AM")
            .unwrap();

        assert_eq!(note.title(), "Daily 2026-07-25");
        assert_eq!(note.content(), "body Daily 2026-07-25");
        assert!(dir.path().join("Daily 2026-07-25.md").exists());
    }

    #[test]
    fn converting_a_note_to_a_template_moves_it_out_of_the_index() {
        let (dir, mut store) = store_with(&[("Meeting.md", "## Agenda\n\n-"), ("Other.md", "x")]);
        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Meeting")
            .unwrap()
            .clone();

        let template = store.convert_to_template(&note).unwrap();
        assert_eq!(template.name, "Meeting");
        assert!(dir.path().join("Templates/Meeting.md").exists());
        assert!(!dir.path().join("Meeting.md").exists());
        // Gone from the note list, present as a template.
        assert_eq!(titles(&store), vec!["Other"]);
        assert_eq!(store.templates().len(), 1);
        // The text is untouched — a template is just a note living elsewhere.
        assert_eq!(
            fs::read_to_string(dir.path().join("Templates/Meeting.md")).unwrap(),
            "## Agenda\n\n-"
        );
    }

    // --- Trash --------------------------------------------------------------

    #[test]
    fn delete_moves_to_trash_and_restore_brings_it_back() {
        let (dir, mut store) = store_with(&[("A.md", "body"), ("B.md", "other")]);
        let a = store
            .notes()
            .iter()
            .find(|n| n.title() == "A")
            .unwrap()
            .clone();

        store.delete(&[a]);
        assert_eq!(titles(&store), vec!["B"]);
        assert!(!dir.path().join("A.md").exists());
        assert!(dir.path().join(".trash/A.md").exists());
        assert_eq!(store.trashed_notes().len(), 1);
        assert!(store.can_restore_last_deleted());

        let restored = store.restore_last_deleted();
        assert_eq!(restored.len(), 1);
        assert_eq!(titles(&store), vec!["A", "B"]);
        assert!(dir.path().join("A.md").exists());
        assert!(store.trashed_notes().is_empty());
    }

    /// A bulk delete is one action for undo purposes.
    #[test]
    fn a_bulk_delete_restores_as_one_action() {
        let (_d, mut store) = store_with(&[("A.md", "x"), ("B.md", "y"), ("C.md", "z")]);
        let doomed: Vec<Note> = store
            .notes()
            .iter()
            .filter(|n| n.title() != "C")
            .cloned()
            .collect();
        store.delete(&doomed);
        assert_eq!(titles(&store), vec!["C"]);
        store.restore_last_deleted();
        assert_eq!(titles(&store), vec!["A", "B", "C"]);
    }

    /// A note whose original location has been reused is skipped rather than
    /// overwriting the new occupant.
    #[test]
    fn restore_skips_a_note_whose_slot_was_reused() {
        let (dir, mut store) = store_with(&[("A.md", "original")]);
        let a = store.notes()[0].clone();
        store.delete(&[a]);
        fs::write(dir.path().join("A.md"), "a different note").unwrap();

        let restored = store.restore_last_deleted();
        assert!(restored.is_empty());
        assert_eq!(
            fs::read_to_string(dir.path().join("A.md")).unwrap(),
            "a different note"
        );
    }

    #[test]
    fn empty_trash_removes_everything() {
        let (dir, mut store) = store_with(&[("A.md", "x")]);
        let a = store.notes()[0].clone();
        store.delete(&[a]);
        assert_eq!(store.trashed_notes().len(), 1);

        store.empty_trash();
        assert!(store.trashed_notes().is_empty());
        assert!(!dir.path().join(".trash").exists());
    }

    #[test]
    fn restore_from_trash_returns_it_to_its_own_folder() {
        let (dir, mut store) = store_with(&[("Inbox/Fleeting.md", "x")]);
        let note = store.notes()[0].clone();
        store.delete(&[note]);
        assert!(dir.path().join("Inbox/.trash/Fleeting.md").exists());

        let trashed = store.trashed_notes()[0].clone();
        let restored = store.restore_from_trash(&trashed).unwrap();
        // Back to Inbox/, not the Index root — the trash folder's parent *is*
        // the folder it came from.
        assert_eq!(restored.url().parent().unwrap().file_name().unwrap(), "Inbox");
    }

    // --- Inbox --------------------------------------------------------------

    #[test]
    fn submit_moves_a_fleeting_note_into_the_index() {
        let (dir, mut store) = store_with(&[("Inbox/Captured.md", "a thought")]);
        let note = store.notes()[0].clone();
        let filed = store.submit_from_inbox(&note).unwrap();

        assert_eq!(filed.url().parent().unwrap(), dir.path());
        assert!(dir.path().join("Captured.md").exists());
        assert!(!dir.path().join("Inbox/Captured.md").exists());
        // The text is untouched — nothing about having been fleeting survives.
        assert_eq!(filed.content(), "a thought");
    }

    #[test]
    fn submit_refuses_a_note_that_is_not_fleeting() {
        let (_d, mut store) = store_with(&[("Filed.md", "x")]);
        let note = store.notes()[0].clone();
        assert!(store.submit_from_inbox(&note).is_none());
    }

    #[test]
    fn create_inbox_note_makes_the_folder_on_demand() {
        let (dir, mut store) = store_with(&[]);
        assert!(!dir.path().join("Inbox").exists());
        let note = store.create_inbox_note("Thought").unwrap();
        assert!(crate::search::is_inbox_note(&note));
        assert!(dir.path().join("Inbox/Thought.md").exists());
    }
}
