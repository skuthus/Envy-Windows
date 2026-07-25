//! The Tauri shell. Owns one `NoteStore` and exposes it to the frontend.
//!
//! Deliberately thin: every decision about what a note *means* lives in
//! `envy-core`, which knows nothing about Tauri or a UI. This layer only
//! serializes across the boundary.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use envy_core::{IndexWatcher, NoteStore, SearchContext};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// A note as the frontend sees it. The store's `Note` isn't serialized
/// directly — its derived values are lazy and private, and the UI wants them
/// resolved (title, preview, due) rather than the raw content alone.
#[derive(Serialize)]
pub struct NoteDto {
    id: String,
    title: String,
    preview: String,
    /// Only sent for the note actually open in the editor — shipping every
    /// note's full text to the frontend on every keystroke would defeat the
    /// point of the lazy cache in the first place.
    content: Option<String>,
    #[serde(rename = "modifiedMs")]
    modified_ms: u64,
    due: Option<String>,
    #[serde(rename = "dueCount")]
    due_count: usize,
    tags: Vec<String>,
    #[serde(rename = "isInbox")]
    is_inbox: bool,
    #[serde(rename = "aiProvenance")]
    ai_provenance: String,
    #[serde(rename = "hasUncheckedTask")]
    has_unchecked_task: bool,
}

impl NoteDto {
    fn from_note(note: &envy_core::Note, with_content: bool) -> Self {
        Self {
            id: note.id().to_string(),
            title: note.title().to_string(),
            preview: note.preview().to_string(),
            content: with_content.then(|| note.content().to_string()),
            modified_ms: note
                .modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            due: note.due().map(|d| d.to_string()),
            due_count: note.due_date_count(),
            tags: note.tags().iter().cloned().collect(),
            is_inbox: envy_core::search::is_inbox_note(note),
            ai_provenance: format!("{:?}", note.ai_provenance()).to_lowercase(),
            has_unchecked_task: note.has_unchecked_task(),
        }
    }
}

pub struct AppState {
    store: Mutex<NoteStore>,
    /// Envy's own writes trip the watcher exactly like an external edit would.
    /// Suppressing a brief window after each one stops a redundant rescan —
    /// and, more importantly, stops a reload landing on top of text the user
    /// is still typing. This is `markInternalWrite` on the Mac.
    suppress_until: Arc<Mutex<Instant>>,
    /// Held only to keep the watch alive; dropping it stops the watcher.
    _watcher: Mutex<Option<IndexWatcher>>,
}

const SUPPRESS_WINDOW: Duration = Duration::from_millis(500);

impl AppState {
    fn mark_internal_write(&self) {
        *self.suppress_until.lock().unwrap() = Instant::now() + SUPPRESS_WINDOW;
    }
}

fn default_index_directory() -> PathBuf {
    // %USERPROFILE%\Documents\Envy — the Windows equivalent of the Mac's
    // ~/Documents/Envy.
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Envy")
}

#[tauri::command]
fn index_directory(state: State<AppState>) -> String {
    state
        .store
        .lock()
        .unwrap()
        .directory()
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
fn search(query: String, state: State<AppState>) -> Vec<NoteDto> {
    let store = state.store.lock().unwrap();
    let ctx = SearchContext::now();
    envy_core::filtered(store.notes(), &query, &ctx)
        .into_iter()
        .map(|n| NoteDto::from_note(n, false))
        .collect()
}

#[tauri::command]
fn read_note(id: String, state: State<AppState>) -> Option<NoteDto> {
    let store = state.store.lock().unwrap();
    store
        .notes()
        .iter()
        .find(|n| n.id() == id)
        .map(|n| NoteDto::from_note(n, true))
}

#[tauri::command]
fn save_note(id: String, content: String, state: State<AppState>) -> Result<(), String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(mut note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    note.set_content(content);
    store.save(&note).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_note(title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    store
        .create(&title)
        .map(|n| NoteDto::from_note(&n, true))
        .map_err(|e| e.to_string())
}

/// Follows a `[[wiki-link]]`, creating the target note if it doesn't exist —
/// which is most of what makes linking feel immediate rather than clerical.
#[tauri::command]
fn open_link(target: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    store
        .open_or_create_link(&target)
        .map(|n| NoteDto::from_note(&n, true))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_note(id: String, title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store
        .rename(&note, &title)
        .map(|n| NoteDto::from_note(&n, true))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note(id: String, state: State<AppState>) -> Result<(), String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store.delete(&[note]);
    Ok(())
}

#[tauri::command]
fn restore_last_deleted(state: State<AppState>) -> Vec<NoteDto> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    store
        .restore_last_deleted()
        .iter()
        .map(|n| NoteDto::from_note(n, false))
        .collect()
}

#[tauri::command]
fn can_restore(state: State<AppState>) -> bool {
    state.store.lock().unwrap().can_restore_last_deleted()
}

/// Re-reads the Index from disk. Called on window focus for now — the file
/// watcher will make this automatic, but until then focusing the window after
/// editing a note elsewhere is enough to pick the change up.
#[tauri::command]
fn reload(state: State<AppState>) -> usize {
    let mut store = state.store.lock().unwrap();
    store.reload();
    store.notes().len()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = default_index_directory();
            let store = NoteStore::open(&dir, false)?;
            // A brand-new Index gets a welcome note, so the first launch isn't
            // an empty window with no hint of what to type.
            if store.notes().is_empty() {
                let welcome = dir.join("Welcome to Envy.md");
                if !welcome.exists() {
                    std::fs::write(&welcome, WELCOME_NOTE)?;
                }
            }
            let store = NoteStore::open(&dir, false)?;

            let suppress_until = Arc::new(Mutex::new(Instant::now()));

            let handle = app.handle().clone();
            let suppress = Arc::clone(&suppress_until);
            let watcher = envy_core::watch_path(dir.clone(), move || {
                // Envy's own writes trip the watcher too. Skipping them avoids
                // a redundant rescan and, more importantly, avoids reloading
                // over text still being typed.
                if Instant::now() < *suppress.lock().unwrap() {
                    return;
                }
                let Some(state) = handle.try_state::<AppState>() else {
                    return;
                };
                state.store.lock().unwrap().reload();
                // The frontend re-runs its query rather than being handed
                // results, so a reload can't clobber whatever the user has
                // since typed into the search box.
                let _ = handle.emit("index-changed", ());
            })
            .ok();

            app.manage(AppState {
                store: Mutex::new(store),
                suppress_until,
                _watcher: Mutex::new(watcher),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            index_directory,
            search,
            read_note,
            save_note,
            create_note,
            open_link,
            rename_note,
            delete_note,
            restore_last_deleted,
            can_restore,
            reload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

const WELCOME_NOTE: &str = r#"# Welcome to Envy

Envy is one search box. Type to filter, press Return to open the top match —
or to create a new note from whatever you typed if nothing matches.

Every note is a plain `.md` file in one folder called The Index. No database,
no proprietary format. Open them in anything.

## Try it

- **Bold**, *italic*, ~~struck through~~, and `code` all render as you type.
- Link notes with [[Another Note]] — following a link creates it if it doesn't
  exist yet.
- Tag anything with #hashtags and search `tag:name` to find it again.
- Write a due date anywhere: @today, @friday, or @12-31-26.
- Task lists work too:

- [ ] Try creating a note
- [ ] Link to it from here
- [x] Read this far

## Search operators

`tag:` `due:` `date:` `link:` `todo:` `orphan:` `linked:` `ai:` `inbox:`

Put a `-` in front of any of them to exclude instead. Separate terms with a
comma to search for either rather than both.
"#;
