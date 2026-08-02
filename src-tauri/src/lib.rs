//! The Tauri shell. Owns one `NoteStore` and exposes it to the frontend.
//!
//! Deliberately thin: every decision about what a note *means* lives in
//! `envy-core`, which knows nothing about Tauri or a UI. This layer only
//! serializes across the boundary.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use envy_core::{IndexWatcher, NoteStore, SearchContext};
use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

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
    /// The folder this note sits in, relative to the Index root, or null at the
    /// root — what the list's folder dot is coloured by. Computed here rather
    /// than derived from `id` in the frontend so the rule for it lives in one
    /// place, next to the move that depends on it.
    subfolder: Option<String>,
}

impl NoteDto {
    /// `root` is the Index directory, needed for `subfolder`. Taken as a path
    /// rather than the store because most callers are mid-mutation and cannot
    /// lend it out again.
    fn from_note(note: &envy_core::Note, with_content: bool, root: &Path) -> Self {
        Self {
            subfolder: envy_core::subfolder_path(note, root),
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
    /// The note pinned to the tray, if any.
    ///
    /// Held here because the tray click handler runs in Rust and has to decide
    /// what to open before any window exists. Durable storage stays in the
    /// frontend alongside the list pins — this is a cache the frontend fills
    /// on boot, not a second source of truth.
    pinned_note: Mutex<Option<String>>,
    /// Envy's own writes trip the watcher exactly like an external edit would.
    /// Suppressing a brief window after each one stops a redundant rescan —
    /// and, more importantly, stops a reload landing on top of text the user
    /// is still typing. This is `markInternalWrite` on the Mac.
    suppress_until: Arc<Mutex<Instant>>,
    /// Held only to keep the watch alive; dropping it stops the watcher.
    _watcher: Mutex<Option<IndexWatcher>>,
    /// Registered global shortcuts, keyed by the shortcut's own id, so the
    /// handler dispatches by lookup rather than re-testing chords it would
    /// then have to keep in step with the frontend's list.
    global_shortcuts: Mutex<std::collections::HashMap<u32, String>>,
    /// The `{{date}}` pattern, mirrored from the frontend's settings.
    ///
    /// Needed here because the tray's "New Pinned Note from Template" builds a
    /// note without any window involved, so it cannot ask the frontend what
    /// format to use.
    template_date_format: Mutex<String>,
    /// Pop-out windows: their label → the note id each one shows. A window's
    /// label can't carry the id (an id is a file path, full of characters a
    /// label forbids), so the page asks for its note through this map. Dead
    /// entries are swept lazily whenever a new pop-out is made.
    popouts: Mutex<std::collections::HashMap<String, String>>,
}

/// Translates the Mac's date tokens to chrono's strftime.
///
/// Deliberately a small fixed set — the same five the Settings pane documents
/// (`yyyy MM dd MMMM EEEE`) — rather than a general pattern language. Longest
/// first, or `MM` consumes the front of `MMMM`.
fn date_pattern_to_strftime(pattern: &str) -> String {
    pattern
        .replace("yyyy", "%Y")
        .replace("MMMM", "%B")
        .replace("EEEE", "%A")
        .replace("MM", "%m")
        .replace("dd", "%d")
}

#[tauri::command]
fn set_template_date_format(pattern: String, state: State<AppState>) {
    *state.template_date_format.lock().unwrap() = pattern;
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

/// Where the chosen Index path is remembered between launches.
///
/// A plain file under the app's config directory, holding one path. The Mac
/// keeps this in UserDefaults under `indexPath`; on Windows the config file is
/// the equivalent, and — unlike the frontend's localStorage — it can be read in
/// Rust's `setup`, before any window exists, so the right vault opens straight
/// away rather than opening the default and switching afterwards.
fn index_path_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("index-path"))
}

/// The Index to open on launch: the remembered one, or the default.
///
/// Mirrors the Mac's `IndexPreference.load()`, including its self-heal: a
/// missing or empty record resolves to the default *and* is written back, so
/// the file always names a real choice after the first run.
fn persisted_index_directory(app: &tauri::AppHandle) -> PathBuf {
    if let Some(file) = index_path_file(app) {
        if let Ok(raw) = std::fs::read_to_string(&file) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
    }
    let fallback = default_index_directory();
    save_index_directory(app, &fallback);
    fallback
}

/// Records `dir` as the Index to open next time. Best-effort: a failure here
/// costs the persistence, not the switch, so the current session is unaffected.
fn save_index_directory(app: &tauri::AppHandle, dir: &Path) {
    let Some(file) = index_path_file(app) else {
        return;
    };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&file, dir.to_string_lossy().as_bytes());
}

// --- Keep Envy on Top --------------------------------------------------------
// Whether the main window floats above other apps' windows. The Windows
// equivalent of the Mac's keepMainWindowOnTop UserDefault: toggled from the
// tray menu, persisted in the app config dir, and re-applied on launch. Only
// the main window — the pinned-note popover already floats on its own.

fn keep_on_top_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("keep-on-top"))
}

fn persisted_keep_on_top(app: &tauri::AppHandle) -> bool {
    keep_on_top_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

fn save_keep_on_top(app: &tauri::AppHandle, on: bool) {
    let Some(file) = keep_on_top_file(app) else {
        return;
    };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&file, if on { "true" } else { "false" });
}

/// Raises or lowers the main window's always-on-top flag, and tells the
/// frontend the new state so it can suppress hide-on-focus-loss while on — a
/// window pinned on top that vanishes the moment you click away would fight
/// itself. Mirrors the Mac, where keepOnTop suppresses the same auto-hide.
fn apply_keep_on_top(app: &tauri::AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(on);
        if !on {
            lower_below_foreground(&w);
        }
        let _ = w.emit("keep-on-top-changed", on);
    }
}

/// After the topmost flag is cleared, drop the window behind whatever's now in
/// front. Windows leaves a de-topmost'd window at the top of the *non*-topmost
/// stack, so turning keep-on-top off from another app would leave Envy still
/// sitting over it — nothing appears to happen. The Mac sets `.level = .normal`
/// and the unfocused window naturally falls behind the active app; this mirrors
/// that by re-inserting the window just under the current foreground window.
/// A no-op when Envy itself is in front (e.g. toggled from its own window).
fn lower_below_foreground(w: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Ok(hwnd) = w.hwnd() else { return };
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == hwnd {
            return;
        }
        let _ = SetWindowPos(
            hwnd,
            Some(fg),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Flips the on-top state, persists it, applies it, and refreshes the tray
/// checkmark — the one action both the tray menu item and the global shortcut
/// trigger, so the two can't drift.
fn toggle_keep_on_top(app: &tauri::AppHandle) {
    let on = !persisted_keep_on_top(app);
    save_keep_on_top(app, on);
    apply_keep_on_top(app, on);
    refresh_tray_menu(app);
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
    let root = store.directory().to_path_buf();
    let ctx = SearchContext::now();
    envy_core::filtered(store.notes(), &query, &ctx, Some(&root))
        .into_iter()
        .map(|n| NoteDto::from_note(n, false, &root))
        .collect()
}

/// Resolves a wiki-link title to a note, without creating one.
///
/// Separate from `open_link`, which creates on miss. An embed pointing at a
/// note that doesn't exist should say so, not quietly bring one into being
/// every time the host note is rendered.
#[tauri::command]
fn resolve_title(title: String, state: State<AppState>) -> Option<NoteDto> {
    let store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .exact_title_match(&title)
        .map(|n| NoteDto::from_note(n, true, &root))
}

#[tauri::command]
fn read_note(id: String, state: State<AppState>) -> Option<NoteDto> {
    let store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .notes()
        .iter()
        .find(|n| n.id() == id)
        .map(|n| NoteDto::from_note(n, true, &root))
}

/// Returns the saved note as the store now sees it.
///
/// Returning it rather than `()` is what keeps the list and the due pill
/// honest. Everything the UI shows about a note besides its text — the due
/// date and its urgency, the tags, the AI badge, whether it still has an
/// unchecked task — is derived from the content that was just written, and a
/// save is the one moment all of it can change at once. The watcher can't
/// cover this: writing suppresses it precisely so a reload can't land on top
/// of someone's typing, so the write that changes a due date is exactly the
/// write the watcher is deaf to.
#[tauri::command]
fn save_note(id: String, content: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(mut note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    note.set_content(content);
    store.save(&note).map_err(|e| e.to_string())?;
    store
        .notes()
        .iter()
        .find(|n| n.id() == id)
        .map(|n| NoteDto::from_note(n, false, &root))
        .ok_or_else(|| format!("note {id} vanished during save"))
}

#[tauri::command]
fn create_note(title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .create(&title)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

/// Creates a note inside an existing subfolder — the `Folder/Title` quick-create
/// from the search box. The frontend only calls this once it has matched the
/// folder against a real subfolder, so an unknown folder never reaches here.
#[tauri::command]
fn create_note_in_subfolder(
    title: String,
    subfolder: String,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .create_in_subfolder(&title, &subfolder)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

/// Splits a selection off into a note of its own, returning it so the caller
/// can leave a `[[link]]` where the text used to be.
///
/// `in_inbox` follows wherever new notes go, so extracting obeys the same
/// setting as writing one from scratch.
#[tauri::command]
fn extract_to_note(
    selection: String,
    in_inbox: bool,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    let (title, body) = NoteStore::extracted_title_and_body(&selection);
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let mut note = if in_inbox {
        store.create_inbox_note(&title)
    } else {
        store.create(&title)
    }
    .map_err(|e| e.to_string())?;
    // Saved only when there is something to save — an extraction whose title
    // used up the whole selection leaves a note with just its name, and writing
    // an empty body over that is pointless work.
    if !body.is_empty() {
        note.set_content(body);
        store.save(&note).map_err(|e| e.to_string())?;
    }
    Ok(NoteDto::from_note(&note, true, &root))
}

/// Opens a link from a note in the default browser.
///
/// The scheme is checked rather than trusted. This opens whatever a note's text
/// says, and a note can be written by anything — synced in, pasted, or edited
/// outside Envy — so restricting it to http and https keeps a file:// or a
/// shell-adjacent scheme in someone's notes from becoming a way to launch
/// things by clicking a link that looked ordinary.
#[tauri::command]
fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let lowered = url.to_lowercase();
    if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
        return Err(format!("refusing to open a non-web link: {url}"));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Every folder under the Index a note could be filed into, for the "Move to"
/// menu. Walked fresh each time the menu opens rather than cached — folders
/// change from outside Envy as easily as from within it.
#[tauri::command]
fn list_subfolders(state: State<AppState>) -> Vec<String> {
    state.store.lock().unwrap().subfolders()
}

/// Files a note into `subfolder`, or to the Index root when it is null.
///
/// A real file move, so the category is on disk and portable. The title is
/// untouched, which is what keeps `[[links]]` pointing at it working.
#[tauri::command]
fn move_note_to_subfolder(
    id: String,
    subfolder: Option<String>,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .move_note(&id, subfolder.as_deref())
        .map(|n| NoteDto::from_note(&n, false, &root))
        .ok_or_else(|| "could not move that note".to_string())
}

/// One row of a browse catalog: a folder or tag name, and how many notes it
/// holds.
#[derive(Serialize)]
struct CatalogRow {
    name: String,
    count: usize,
}

/// The `folder:` catalog — every folder with its note count, most-used first.
#[tauri::command]
fn folder_catalog(state: State<AppState>) -> Vec<CatalogRow> {
    state
        .store
        .lock()
        .unwrap()
        .folder_counts()
        .into_iter()
        .map(|(name, count)| CatalogRow { name, count })
        .collect()
}

/// The `tag:` catalog — every tag with its note count, most-used first.
#[tauri::command]
fn tag_catalog(state: State<AppState>) -> Vec<CatalogRow> {
    state
        .store
        .lock()
        .unwrap()
        .tag_counts()
        .into_iter()
        .map(|(name, count)| CatalogRow { name, count })
        .collect()
}

/// Renames a folder across the vault, carrying every note inside it. Returns the
/// folder's new relative path, or an error if the rename was refused (a reserved
/// or already-taken name, or an empty target).
#[tauri::command]
fn rename_folder(
    old_path: String,
    new_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    state.mark_internal_write();
    state
        .store
        .lock()
        .unwrap()
        .rename_folder(&old_path, &new_path)
        .ok_or_else(|| {
            "That name is already taken, reserved, or empty.".to_string()
        })
}

/// Renames a tag across every note that carries it, merging when the new name
/// already exists.
#[tauri::command]
fn rename_tag(old_name: String, new_name: String, state: State<AppState>) {
    state.mark_internal_write();
    state.store.lock().unwrap().rename_tag(&old_name, &new_name);
}

/// Follows a `[[wiki-link]]`, creating the target note if it doesn't exist —
/// which is most of what makes linking feel immediate rather than clerical.
#[tauri::command]
fn open_link(target: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .open_or_create_link(&target)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_note(id: String, title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store
        .rename(&note, &title)
        .map(|n| NoteDto::from_note(&n, true, &root))
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

/// Notes currently sitting in any `.trash` folder, filtered by the text typed
/// after `trash:`. An empty fragment matches everything, the same way
/// `template:` shows every template until you narrow it.
///
/// Content is included: the trash preview shows the note's text, and a trashed
/// note is not in `notes()`, so `read_note` cannot reach it.
#[tauri::command]
fn trashed_notes(fragment: String, state: State<AppState>) -> Vec<NoteDto> {
    let needle = fragment.trim().to_lowercase();
    let store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .trashed_notes()
        .iter()
        .filter(|n| needle.is_empty() || n.lowercased_title().contains(&needle))
        .map(|n| NoteDto::from_note(n, true, &root))
        .collect()
}

#[tauri::command]
fn restore_from_trash(id: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(note) = store.trashed_notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no trashed note with id {id}"));
    };
    store
        .restore_from_trash(&note)
        .map(|n| NoteDto::from_note(&n, false, &root))
        .ok_or_else(|| "could not restore the note".to_string())
}

#[tauri::command]
fn delete_from_trash(id: String, state: State<AppState>) -> Result<(), String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.trashed_notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no trashed note with id {id}"));
    };
    store.delete_from_trash(&note);
    Ok(())
}

/// Reveals one of the Index's own folders. `which` is "index", "templates" or
/// "trash" — the trash folder is the one beside the Index root, which is where
/// top-level deletions land.
#[tauri::command]
fn reveal_folder(which: String, state: State<AppState>) -> Result<(), String> {
    let dir = state.store.lock().unwrap().directory().to_path_buf();
    let path = match which.as_str() {
        "templates" => dir.join("Templates"),
        "trash" => dir.join(".trash"),
        _ => dir,
    };
    // Created on demand: Explorer cannot show a folder that doesn't exist yet,
    // and neither Templates/ nor .trash/ exists until first used.
    let _ = std::fs::create_dir_all(&path);
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Re-points the store at a different folder.
#[tauri::command]
fn set_index_directory(
    path: String,
    include_subfolders: bool,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let store = NoteStore::open(&path, include_subfolders).map_err(|e| e.to_string())?;
    let count = store.notes().len();
    *state.store.lock().unwrap() = store;
    // Remembered for next launch, so the choice sticks rather than resetting to
    // the default folder every restart.
    save_index_directory(&app, Path::new(&path));
    // The old watcher is still pointed at the previous folder; replacing it is
    // what makes external edits in the new one register at all.
    let handle = app.clone();
    let suppress = Arc::clone(&state.suppress_until);
    let watcher = envy_core::watch_path(PathBuf::from(&path), move || {
        if std::time::Instant::now() < *suppress.lock().unwrap() {
            return;
        }
        let Some(s) = handle.try_state::<AppState>() else { return };
        s.store.lock().unwrap().reload();
        let _ = handle.emit("index-changed", ());
    })
    .ok();
    *state._watcher.lock().unwrap() = watcher;
    Ok(count)
}

#[tauri::command]
fn empty_trash(state: State<AppState>) -> usize {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let count = store.trashed_notes().len();
    store.empty_trash();
    count
}

/// Deletes several notes as one action.
///
/// One call rather than a loop of `delete_note`, because the store treats a
/// single `delete` as one undo step — `restore_last_deleted` brings the whole
/// batch back. Looping would leave only the last note restorable.
#[tauri::command]
fn delete_notes(ids: Vec<String>, state: State<AppState>) -> Result<usize, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let notes: Vec<_> = store
        .notes()
        .iter()
        .filter(|n| ids.iter().any(|i| i == n.id()))
        .cloned()
        .collect();
    let count = notes.len();
    store.delete(&notes);
    Ok(count)
}

#[tauri::command]
fn restore_last_deleted(state: State<AppState>) -> Vec<NoteDto> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .restore_last_deleted()
        .iter()
        .map(|n| NoteDto::from_note(n, false, &root))
        .collect()
}

#[derive(Serialize)]
pub struct TemplateDto {
    id: String,
    name: String,
}

/// Templates whose name contains `fragment`. An empty fragment (just
/// "template:" typed so far) matches everything, the same way `tag:` shows
/// everything until you narrow it.
#[tauri::command]
fn list_templates(fragment: String, state: State<AppState>) -> Vec<TemplateDto> {
    let needle = fragment.trim().to_lowercase();
    state
        .store
        .lock()
        .unwrap()
        .templates()
        .into_iter()
        .filter(|t| needle.is_empty() || t.name.to_lowercase().contains(&needle))
        .map(|t| TemplateDto {
            id: t.path.to_string_lossy().into_owned(),
            name: t.name,
        })
        .collect()
}

/// A template is a plain `.md` file, so this is a plain read — deliberately
/// not routed through the note store, which never treats one as a note.
/// Creates a note from a template, with the tokens substituted.
///
/// An explicit action rather than a side effect of opening a template to look
/// at it — the Mac makes the same split, and browsing your templates should
/// not litter the Index with notes.
#[tauri::command]
fn create_note_from_template(
    path: String,
    title: String,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(template) = store.templates().into_iter().find(|t| t.path.to_string_lossy() == path)
    else {
        return Err("no such template".to_string());
    };
    let now = chrono::Local::now();
    let pattern = state.template_date_format.lock().unwrap().clone();
    store
        .create_from_template(
            &title,
            &template,
            &now.format(&date_pattern_to_strftime(&pattern)).to_string(),
            &now.format("%-I:%M %p").to_string(),
        )
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_template(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_template(path: String, content: String, state: State<AppState>) -> Result<(), String> {
    // Templates live inside The Index, so writing one trips the watcher just
    // like a note does.
    state.mark_internal_write();
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// How many notes are waiting in `Inbox/`.
///
/// Counted across every note rather than the filtered list, so the badge shows
/// the size of the backlog and not of whatever happens to be on screen.
/// Every tag in use, for the search box's ghost-text completion.
///
/// Sorted by how often each is used rather than alphabetically: completing to
/// the tag you reach for most is right far more often than completing to the
/// one that happens to start with an early letter.
#[tauri::command]
fn all_tags(state: State<AppState>) -> Vec<String> {
    let store = state.store.lock().unwrap();
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for note in store.notes() {
        for tag in note.tags() {
            *counts.entry(tag.clone()).or_default() += 1;
        }
    }
    let mut tags: Vec<_> = counts.into_iter().collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    tags.into_iter().map(|(t, _)| t).collect()
}

/// Every note's title, newest first — for the search box's autofill of the
/// title-taking operators (`link:`, `interlink:`, `title:`). The store already
/// holds notes in modified-descending order, so this is just a projection.
#[tauri::command]
fn all_titles(state: State<AppState>) -> Vec<String> {
    state
        .store
        .lock()
        .unwrap()
        .notes()
        .iter()
        .map(|n| n.title().to_string())
        .collect()
}

#[tauri::command]
fn inbox_count(state: State<AppState>) -> usize {
    state
        .store
        .lock()
        .unwrap()
        .notes()
        .iter()
        .filter(|n| envy_core::search::is_inbox_note(n))
        .count()
}

/// Whole-vault totals for the footer: every loaded note (fleeting ones
/// included; Templates and Trash never load) and the subfolder count. Both are
/// cheap reads. Mirrors the Mac's vaultCountsLabel inputs — the folder count is
/// only *shown* when subfolder scanning is on, which the frontend decides.
#[derive(Serialize)]
struct VaultCounts {
    notes: usize,
    folders: usize,
}

/// The remembered on-top state, for the frontend to suppress hide-on-focus-loss
/// while it's on.
#[tauri::command]
fn keep_on_top(app: tauri::AppHandle) -> bool {
    persisted_keep_on_top(&app)
}

#[tauri::command]
fn vault_counts(state: State<AppState>) -> VaultCounts {
    let store = state.store.lock().unwrap();
    VaultCounts {
        notes: store.notes().len(),
        folders: store.subfolders().len(),
    }
}

/// Files a fleeting note into the Index proper — a plain move out of `Inbox/`.
/// The note's text is untouched, so nothing about having been fleeting
/// survives in the file.
#[tauri::command]
fn submit_from_inbox(id: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store
        .submit_from_inbox(&note)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .ok_or_else(|| "that note is not in the Inbox".to_string())
}

#[tauri::command]
fn create_inbox_note(title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .create_inbox_note(&title)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct InterlinkRefDto {
    id: String,
    title: String,
}

#[derive(Serialize)]
pub struct SuggestionDto {
    title: String,
    /// UTF-16 offsets, so the editor can use them as string indices directly.
    start: usize,
    end: usize,
}

#[derive(Serialize)]
pub struct InterlinksDto {
    links: Vec<InterlinkRefDto>,
    backlinks: Vec<InterlinkRefDto>,
    suggested: Vec<SuggestionDto>,
}

#[tauri::command]
fn interlinks(id: String, state: State<AppState>) -> InterlinksDto {
    let store = state.store.lock().unwrap();
    let Some(note) = store.notes().iter().find(|n| n.id() == id) else {
        return InterlinksDto {
            links: Vec::new(),
            backlinks: Vec::new(),
            suggested: Vec::new(),
        };
    };
    let result = envy_core::interlinks_for(note, store.notes());
    let to_dto = |r: &envy_core::InterlinkRef| InterlinkRefDto {
        id: r.id.clone(),
        title: r.title.clone(),
    };
    InterlinksDto {
        links: result.links.iter().map(to_dto).collect(),
        backlinks: result.backlinks.iter().map(to_dto).collect(),
        suggested: result
            .suggested
            .iter()
            .map(|s| SuggestionDto {
                title: s.title.clone(),
                start: s.start,
                end: s.end,
            })
            .collect(),
    }
}

#[tauri::command]
fn can_restore(state: State<AppState>) -> bool {
    state.store.lock().unwrap().can_restore_last_deleted()
}

#[tauri::command]
fn set_include_subfolders(include: bool, state: State<AppState>) -> usize {
    let mut store = state.store.lock().unwrap();
    store.set_include_subfolders(include);
    store.notes().len()
}

/// Opens The Index in Explorer. The folder being an ordinary folder of
/// ordinary files is the whole premise, so making it one click away matters
/// more than it would in an app that owned its storage.
#[tauri::command]
fn reveal_index(state: State<AppState>) -> Result<(), String> {
    let dir = state.store.lock().unwrap().directory().to_path_buf();
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens Explorer with one note selected — the Mac's "Open in Finder".
///
/// `explorer /select,<path>` returns a non-zero exit code even when it works,
/// which is long-standing Windows behaviour rather than a failure, so the
/// status is deliberately not checked.
///
/// The command line is built with `raw_arg`, not `arg`, on purpose. `arg`
/// quotes any value containing a space, which for a vault like
/// `D:\Documents\Envy Benchmark\Note.md` yields `explorer "/select,D:\…\Note.md"`
/// — the whole switch wrapped in one pair of quotes. Explorer can't parse that
/// and silently opens the user's Documents folder instead of selecting the
/// file. The form it actually wants is `/select,"<path>"`: the switch bare, only
/// the path quoted. `raw_arg` appends exactly that, byte for byte.
#[tauri::command]
fn reveal_note(id: String, state: State<AppState>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let path = {
        let store = state.store.lock().unwrap();
        // Trash is searched too: "Reveal in Explorer" is offered on trashed
        // notes as well, and those are not in `notes()`.
        store
            .notes()
            .iter()
            .chain(store.trashed_notes().iter())
            .find(|n| n.id() == id)
            .map(|n| n.url().to_path_buf())
            .ok_or_else(|| format!("no note with id {id}"))?
    };
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn convert_to_template(id: String, state: State<AppState>) -> Result<TemplateDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store
        .convert_to_template(&note)
        .map(|t| TemplateDto {
            id: t.path.to_string_lossy().into_owned(),
            name: t.name,
        })
        .ok_or_else(|| "could not move the note into Templates".to_string())
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

/// Parses a binding like "Ctrl+Alt+Shift+P" into a Shortcut.
///
/// The string form comes from the frontend, which is where remapping happens;
/// this is the one place it becomes an OS registration.
fn parse_shortcut(binding: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    let mut mods = Modifiers::empty();
    let mut code = None;
    for part in binding.split('+') {
        match part.trim() {
            "Ctrl" => mods |= Modifiers::CONTROL,
            "Alt" => mods |= Modifiers::ALT,
            "Shift" => mods |= Modifiers::SHIFT,
            "Enter" => code = Some(Code::Enter),
            "Space" => code = Some(Code::Space),
            "Backspace" => code = Some(Code::Backspace),
            "ArrowDown" => code = Some(Code::ArrowDown),
            "ArrowUp" => code = Some(Code::ArrowUp),
            "ArrowLeft" => code = Some(Code::ArrowLeft),
            "ArrowRight" => code = Some(Code::ArrowRight),
            other if other.len() == 1 => {
                let c = other.chars().next().unwrap().to_ascii_uppercase();
                code = match c {
                    'A'..='Z' => Some(letter_code(c)),
                    '0'..='9' => Some(digit_code(c)),
                    ',' => Some(Code::Comma),
                    '.' => Some(Code::Period),
                    '-' => Some(Code::Minus),
                    '=' => Some(Code::Equal),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    code.map(|c| Shortcut::new(if mods.is_empty() { None } else { Some(mods) }, c))
}

fn letter_code(c: char) -> tauri_plugin_global_shortcut::Code {
    use tauri_plugin_global_shortcut::Code::*;
    const LETTERS: [tauri_plugin_global_shortcut::Code; 26] = [
        KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO,
        KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ,
    ];
    LETTERS[(c as u8 - b'A') as usize]
}

fn digit_code(c: char) -> tauri_plugin_global_shortcut::Code {
    use tauri_plugin_global_shortcut::Code::*;
    const DIGITS: [tauri_plugin_global_shortcut::Code; 10] = [
        Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9,
    ];
    DIGITS[(c as u8 - b'0') as usize]
}

/// Re-registers the global shortcuts after a remap.
///
/// Everything is unregistered first: leaving the old chord live would mean a
/// remap adds a binding rather than moves one, and the previous one would keep
/// firing with no way to find out why.
#[tauri::command]
fn set_global_shortcuts(
    summon: String,
    show_pinned: String,
    unpin: String,
    keep_on_top: String,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Vec<String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let _ = app.global_shortcut().unregister_all();
    let mut failed = Vec::new();
    let mut registry = state.global_shortcuts.lock().unwrap();
    registry.clear();

    for (id, binding) in [
        ("summonApp", summon),
        ("showPinnedNote", show_pinned),
        ("unpinFromTray", unpin),
        ("keepOnTop", keep_on_top),
    ] {
        let Some(shortcut) = parse_shortcut(&binding) else {
            failed.push(binding);
            continue;
        };
        // Registered individually so one clash doesn't cost the others.
        if app.global_shortcut().register(shortcut).is_err() {
            failed.push(binding.clone());
        }
        // Keyed by the shortcut's own id so the handler can dispatch by
        // lookup rather than by re-testing modifier combinations it would
        // then have to keep in step with the frontend's list.
        registry.insert(shortcut.id(), id.to_string());
    }
    failed
}

/// The summon hotkey.
///
/// `Ctrl+Alt+Enter` is the Windows spelling of the Mac's `⌥⌘↩`: ⌘ maps to
/// Ctrl and ⌥ to Alt, so the shape of the chord is preserved rather than the
/// literal keys. Registration is best-effort — another app may already own the
/// combination, and a note-taking app failing to launch over a hotkey clash
/// would be a poor trade. It is not yet remappable; that needs the shortcuts
/// settings surface.
fn setup_global_hotkey(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::ShortcutState;

    let handle = app.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                // Fire on press only; without this each chord toggles twice
                // per use and lands back where it started.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                // Dispatched by lookup rather than by re-testing chords here,
                // so remapping needs no change on this side at all.
                let action = handle.try_state::<AppState>().and_then(|s| {
                    s.global_shortcuts.lock().unwrap().get(&shortcut.id()).cloned()
                });
                match action.as_deref() {
                    Some("summonApp") => {
                        if let Some(window) = handle.get_webview_window("main") {
                            toggle_window(&window);
                        }
                    }
                    Some("showPinnedNote") => toggle_pinned_window(&handle),
                    Some("keepOnTop") => toggle_keep_on_top(&handle),
                    Some("unpinFromTray") => {
                        if let Some(state) = handle.try_state::<AppState>() {
                            *state.pinned_note.lock().unwrap() = None;
                        }
                        if let Some(w) = handle.get_webview_window(PINNED_WINDOW) {
                            let _ = w.hide();
                        }
                        let _ = handle.emit("pinned-note-changed", ());
                        refresh_tray_menu(&handle);
                    }
                    _ => {}
                }
            })
            .build(),
    )?;
    // Nothing is registered here. The frontend calls set_global_shortcuts on
    // boot with whatever bindings are stored, so defaults and remaps take the
    // same path and cannot drift apart.
    Ok(())
}

/// Builds the tray menu against current state.
///
/// Rebuilt on every open rather than built once, because two of its entries
/// depend on things that change while the app runs: the template list, and
/// whether anything is pinned. A menu assembled at launch would offer
/// templates that have since been deleted and grey out an Unpin that is now
/// live.
fn build_tray_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let new_note = MenuItem::with_id(app, "new_note", "New Note", true, None::<&str>)?;
    let new_pinned =
        MenuItem::with_id(app, "new_pinned", "New Pinned Note", true, None::<&str>)?;

    let templates: Vec<envy_core::NoteTemplate> = app
        .try_state::<AppState>()
        .map(|s| s.store.lock().unwrap().templates())
        .unwrap_or_default();

    let template_submenu = Submenu::with_id(app, "from_template", "New Pinned Note from Template", true)?;
    if templates.is_empty() {
        // Present but disabled, so the feature is discoverable before any
        // template exists rather than the entry simply vanishing.
        template_submenu.append(&MenuItem::with_id(
            app,
            "no_templates",
            "No Templates",
            false,
            None::<&str>,
        )?)?;
    } else {
        for t in &templates {
            template_submenu.append(&MenuItem::with_id(
                app,
                format!("template:{}", t.path.to_string_lossy()),
                &t.name,
                true,
                None::<&str>,
            )?)?;
        }
    }

    let is_pinned = app
        .try_state::<AppState>()
        .map(|s| s.pinned_note.lock().unwrap().is_some())
        .unwrap_or(false);
    let unpin = MenuItem::with_id(app, "unpin", "Unpin Note", is_pinned, None::<&str>)?;

    // Checkmark reflects the current state, same as the Mac's status-menu item.
    let keep_on_top = CheckMenuItem::with_id(
        app,
        "keep_on_top",
        "Keep Envy on Top",
        true,
        persisted_keep_on_top(app),
        None::<&str>,
    )?;

    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    // The Mac carries "Check for Updates…" as a menu command beside the
    // automatic background check, for anyone who would rather ask than wait.
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Envy", true, None::<&str>)?;

    Ok(Menu::with_items(
        app,
        &[
            &new_note,
            &new_pinned,
            &template_submenu,
            &unpin,
            &PredefinedMenuItem::separator(app)?,
            &keep_on_top,
            &settings,
            &check_updates,
            &quit,
        ],
    )?)
}

/// Writes the verified installer to a temp file and starts it *after* this
/// process has had a few seconds to disappear.
///
/// The delay is the whole point, and it exists because of a bug that shipped.
/// `download_and_install` launches the installer and immediately calls
/// `std::process::exit(0)`, so the two race. The installer runs passive, and
/// its check for a running Envy only kills-and-waits when it actually *finds*
/// one — mid-exit it frequently finds nothing and goes straight to copying.
/// The copy then hits an executable Windows still has locked, and because the
/// generated NSIS script sets no `SetOverwrite`, the default `AllowSkipFiles`
/// means a silent install *skips the unwritable file and carries on*. No error,
/// no abort. The script then writes the registry with the new version.
///
/// The result is an install that reports success while leaving the old binary
/// in place, so the app offers the same update on every launch, forever.
/// Observed twice on a real install: registry 0.1.3, binary 0.1.2.
///
/// Waiting removes the race rather than narrowing it. `ping` rather than
/// `timeout`, because `timeout` reads the console and fails outright when there
/// is not one — which is exactly the case for a detached process.
fn launch_installer_after_exit(bytes: &[u8], version: &str) -> std::io::Result<()> {
    let installer = std::env::temp_dir().join(format!("Envy_{version}_x64-setup.exe"));
    std::fs::write(&installer, bytes)?;

    // `/P /R` is passive-with-restart, the same pair Tauri's own passive mode
    // passes, and `/UPDATE` tells the script this is an upgrade rather than a
    // fresh install.
    let mut command = std::process::Command::new("cmd");
    command.arg("/C").arg(format!(
        "ping -n 5 127.0.0.1 >nul & \"{}\" /P /R /UPDATE",
        installer.display()
    ));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Detached so it outlives this process, and windowless so the wait
        // doesn't flash a console over whatever the user is doing.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command.spawn()?;
    Ok(())
}

/// Looks for a newer release and, if the user agrees, installs it and restarts.
///
/// `manual` is the difference between the check the app runs at launch and the
/// one the menu command runs: only the latter reports finding nothing. A
/// background check that announced "no updates" every launch would be noise,
/// but a menu command that appeared to do nothing at all would look broken.
///
/// Note that shipping the public key is only half of what makes updates
/// possible. The installed build also has to actually perform this check —
/// a release that never asks will never discover its successor no matter what
/// key it was signed against.
async fn run_update_check(app: tauri::AppHandle, manual: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };

    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            app.dialog()
                .message(format!(
                    "Envy {version} is available.\n\nInstall it now? Envy will restart."
                ))
                .title("Update Available")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Install".into(),
                    "Later".into(),
                ))
                .show(move |install| {
                    let _ = tx.send(install);
                });
            // The dialog answers on another thread, so this waits for the click
            // rather than racing past it. Safe here because this only ever runs
            // inside a spawned task, never on the thread driving the UI.
            if rx.recv().unwrap_or(false) {
                // No progress or total-length handling: this is a ~10MB
                // download, and a progress bar is worth building when there is
                // somewhere in the interface to put one.
                // Downloaded and launched in two steps rather than through
                // `download_and_install`, which does both and cannot be made to
                // wait. See `launch_installer_after_exit`.
                //
                // `download` is where the signature is checked, so nothing is
                // weakened by taking the bytes and running the installer here —
                // they arrive already verified against the key compiled into
                // this build.
                let staged = match update.download(|_, _| {}, || {}).await {
                    Ok(bytes) => launch_installer_after_exit(&bytes, &version)
                        .map_err(|e| e.to_string()),
                    Err(e) => Err(e.to_string()),
                };
                match staged {
                    // The installer is waiting for this process to go away.
                    Ok(()) => app.exit(0),
                    Err(e) => {
                        app.dialog()
                            .message(format!("The update could not be installed.\n\n{e}"))
                            .kind(MessageDialogKind::Error)
                            .title("Update Failed")
                            .blocking_show();
                    }
                }
            }
        }
        Ok(None) => {
            if manual {
                app.dialog()
                    .message("Envy is up to date.")
                    .title("No Updates")
                    .blocking_show();
            }
        }
        Err(e) => {
            // A failed background check is not worth interrupting anyone for —
            // being offline is the usual cause, and it will try again next
            // launch. A check the user explicitly asked for does need an answer.
            if manual {
                app.dialog()
                    .message(format!("Could not check for updates.\n\n{e}"))
                    .kind(MessageDialogKind::Error)
                    .title("Update Check Failed")
                    .blocking_show();
            } else {
                eprintln!("background update check failed: {e}");
            }
        }
    }

    // A check ran to completion (found nothing, failed, or the user deferred an
    // install) — tell the frontend so it can stamp "last checked". Fires for
    // every path here, so a tray-triggered check updates the label too. Not
    // reached when an install starts, since that exits the process first.
    let _ = app.emit("update-checked", ());
}

/// The frontend's entry point to the same check the tray command and the launch
/// task run — used both for the automatic check at boot (when the setting is on)
/// and the Settings "Check Now" button. `manual` gets the "you're up to date"
/// reassurance; the background check stays silent when it finds nothing.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle, manual: bool) {
    run_update_check(app, manual).await;
}

/// Re-applies the tray menu after anything it reflects has changed.
///
/// The menu is a snapshot: Tauri hands the OS a built menu rather than asking
/// us to fill one on open, so "Unpin Note" would stay greyed out after a pin,
/// and a freshly made template would not appear, unless it is replaced.
fn refresh_tray_menu(app: &tauri::AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), build_tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Creates a note and pins it to the tray, then shows it — "New Pinned Note"
/// and its template variants. Returns nothing useful; the popover reads the
/// pinned id for itself.
fn create_and_pin(app: &tauri::AppHandle, template_path: Option<&str>) {
    let Some(state) = app.try_state::<AppState>() else { return };
    state.mark_internal_write();

    let created = {
        let mut store = state.store.lock().unwrap();
        match template_path {
            Some(path) => {
                let template = store.templates().into_iter().find(|t| t.path.to_string_lossy() == path);
                match template {
                    // Date and time are formatted here rather than in the
                    // core, which stays UI-agnostic and owns no date style.
                    Some(t) => {
                        let now = chrono::Local::now();
                        let pattern = state.template_date_format.lock().unwrap().clone();
                        store.create_from_template(
                            "",
                            &t,
                            &now.format(&date_pattern_to_strftime(&pattern)).to_string(),
                            &now.format("%-I:%M %p").to_string(),
                        )
                    }
                    None => return,
                }
            }
            None => store.create("Untitled"),
        }
    };

    let Ok(note) = created else { return };
    *state.pinned_note.lock().unwrap() = Some(note.id().to_string());
    let _ = app.emit("pinned-note-changed", ());
    refresh_tray_menu(app);
    show_pinned_window(app);
}

/// The notification-area icon — Windows' counterpart to the Mac's menu bar
/// item. Left click toggles the window, exactly as the hotkey does; the menu
/// is for the things a click can't express.
fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().ok_or("no window icon")?)
        .tooltip("Envy")
        .menu(&build_tray_menu(app)?)
        // Without this a left click opens the menu instead of reaching the
        // click handler, and the single most common gesture would be wrong.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            // Template entries carry their path in the id, since the menu is
            // rebuilt each time and closures over a Vec would go stale.
            if let Some(path) = id.strip_prefix("template:") {
                create_and_pin(app, Some(path));
                return;
            }
            match id {
                "new_note" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                        let _ = w.emit("new-note", ());
                    }
                }
                "new_pinned" => create_and_pin(app, None),
                "unpin" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        *state.pinned_note.lock().unwrap() = None;
                    }
                    if let Some(w) = app.get_webview_window(PINNED_WINDOW) {
                        let _ = w.hide();
                    }
                    let _ = app.emit("pinned-note-changed", ());
    refresh_tray_menu(app);
                }
                "keep_on_top" => toggle_keep_on_top(app),
                "settings" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                        let _ = w.emit("open-settings", ());
                    }
                }
                "check_updates" => {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(run_update_check(handle, true));
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                // With a note pinned, a click opens *it* rather than summoning
                // the app — that substitution is the whole feature. Without
                // one, the click falls back to showing Envy.
                let pinned = app
                    .try_state::<AppState>()
                    .and_then(|s| s.pinned_note.lock().unwrap().clone());
                if pinned.is_some() {
                    toggle_pinned_window(app);
                } else if let Some(w) = app.get_webview_window("main") {
                    toggle_window(&w);
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Show-or-hide, the behaviour the summon hotkey and the tray click share.
///
/// Hiding rather than minimising is deliberate: Envy is meant to be summoned
/// and dismissed, so it should leave the taskbar and Alt-Tab entirely rather
/// than sit there as a minimised window you then have to find.
///
/// The test is *visible*, not visible-and-focused. Whether the window is on
/// screen is the whole question; the app's activation state is a different
/// one. Checking focus broke the tray entirely — clicking a tray icon takes
/// focus away from the window, so by the time this ran the window was never
/// focused and the click could only ever show, never hide.
///
/// A minimised window counts as "not on screen" and is restored rather than
/// hidden, so a window minimised the ordinary way comes back instead of
/// vanishing further.
fn toggle_window(window: &WebviewWindow) {
    let visible = window.is_visible().unwrap_or(false);
    let minimised = window.is_minimized().unwrap_or(false);
    if visible && !minimised {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Announces the summon rather than dictating what happens next. Where
        // focus lands is the "Keep focus where it was when summoned" setting,
        // which lives in the frontend, so this used to be an unconditional
        // "focus-search" — which is that setting permanently switched off, and
        // the opposite of the Mac's default.
        let _ = window.emit("summoned", ());
    }
}

const PINNED_WINDOW: &str = "pinned";

#[tauri::command]
fn pinned_note_id(state: State<AppState>) -> Option<String> {
    state.pinned_note.lock().unwrap().clone()
}

#[tauri::command]
fn set_pinned_note(id: Option<String>, app: tauri::AppHandle, state: State<AppState>) {
    *state.pinned_note.lock().unwrap() = id.clone();
    if id.is_none() {
        if let Some(w) = app.get_webview_window(PINNED_WINDOW) {
            let _ = w.hide();
        }
    }
    // Both windows care: the popover reloads, and the app repaints its pin
    // marks.
    let _ = app.emit("pinned-note-changed", ());
    refresh_tray_menu(&app);
}

/// Brings the main window forward on a specific note — the popover's "Open"
/// button, which is the bridge from glancing to actually working on it.
#[tauri::command]
fn open_in_main_window(id: String, app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit("open-note", id);
    }
}

/// Creates the popover on first use rather than at launch. It is a window most
/// people will never open, and building it eagerly would cost every user a
/// second webview for a feature they may not use.
fn show_pinned_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(PINNED_WINDOW) {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("pinned-note-changed", ());
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(
        app,
        PINNED_WINDOW,
        tauri::WebviewUrl::App("pinned.html".into()),
    )
    .title("Pinned note")
    .inner_size(420.0, 460.0)
    .resizable(true)
    // Undecorated and always-on-top so it reads as a panel hanging off the
    // tray rather than a second application window.
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build();
    if let Err(e) = built {
        eprintln!("could not open the pinned-note window: {e}");
    }
}

fn toggle_pinned_window(app: &tauri::AppHandle) {
    match app.get_webview_window(PINNED_WINDOW) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            let _ = w.hide();
        }
        _ => show_pinned_window(app),
    }
}

/// Opens a note in its own floating window — the "Pop Out" context-menu action.
/// Several can be open at once, one per note; popping a note out again just
/// surfaces its window. A note id is a file path, which a window label can't
/// hold, so the label is a hash of it and the id is stashed in state for the
/// page to read back through `popout_note_id`.
/// Async on purpose: a sync command runs on the main thread, and building a
/// window from there needs the same event loop to start the new webview — the
/// loop ends up waiting on itself and the app freezes (shell appears, page
/// never loads). Async runs this on a worker thread, so `run_on_main_thread`
/// genuinely hands the build to the free loop instead of running it inline.
#[tauri::command]
async fn pop_out_note(id: String, app: tauri::AppHandle) {
    use std::hash::{Hash, Hasher};

    enum Action {
        Surface(String),
        Create(String, f64),
    }
    // Decide under the lock, then drop it before touching any window.
    let action = {
        let state = app.state::<AppState>();
        let mut popouts = state.popouts.lock().unwrap();
        // Sweep windows that have since closed, so a stale label never shadows a
        // fresh pop-out and the cascade count stays honest.
        popouts.retain(|label, _| app.get_webview_window(label).is_some());
        if let Some(existing) = popouts.iter().find(|(_, nid)| *nid == &id).map(|(l, _)| l.clone()) {
            Action::Surface(existing)
        } else {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            id.hash(&mut hasher);
            let label = format!("popout-{:x}", hasher.finish());
            // Cascade each new one down-and-right, wrapping every 8.
            let step = (popouts.len() % 8) as f64 * 26.0;
            popouts.insert(label.clone(), id.clone());
            Action::Create(label, step)
        }
    };

    match action {
        // Already popped out — surface it rather than opening a second copy.
        Action::Surface(label) => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        Action::Create(label, step) => {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let built = tauri::WebviewWindowBuilder::new(
                    &handle,
                    &label,
                    tauri::WebviewUrl::App("popout.html".into()),
                )
                // Blank native title: the note's name lives in the window's own
                // editable title strip, not doubled in the OS title bar.
                .title("")
                .inner_size(440.0, 480.0)
                .position(140.0 + step, 120.0 + step)
                .min_inner_size(240.0, 160.0)
                .resizable(true)
                // No minimize or maximize: the window is skip_taskbar, so a
                // minimized one would vanish with no taskbar button to restore
                // it. Only close remains, closest to the Mac's button-less
                // pop-out panel — dragging and edge-resize still work.
                .minimizable(false)
                .maximizable(false)
                // Floats above the main window like the Mac's pop-out panel,
                // and stays out of the taskbar so a handful don't clutter it.
                .always_on_top(true)
                .skip_taskbar(true)
                .build();
                if let Err(e) = built {
                    eprintln!("could not open pop-out window: {e}");
                    if let Some(s) = handle.try_state::<AppState>() {
                        s.popouts.lock().unwrap().remove(&label);
                    }
                }
            });
        }
    }
}

/// The note id the calling pop-out window is showing.
#[tauri::command]
fn popout_note_id(window: tauri::WebviewWindow, state: State<AppState>) -> Option<String> {
    state.popouts.lock().unwrap().get(window.label()).cloned()
}

/// Whether the app launches at login.
/// Where Envy appears outside its own window.
///
/// The tray icon is never removed, so there is always a way back to the app
/// besides the global hotkey — the Mac makes the same guarantee with "always
/// at least one of the two". Only the taskbar entry is optional.
#[tauri::command]
fn set_show_in_taskbar(show: bool, app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_skip_taskbar(!show);
    }
}

#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Checks the endpoint in tauri.conf.json and verifies whatever it finds
        // against the public key compiled in beside it. That key is why this has
        // to exist before the first release rather than after: an install that
        // shipped without it has nothing to verify an update with, so it can
        // never update itself — only a manual reinstall fixes it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The window comes back the size and place it was left. macOS gives a
        // WindowGroup this for free through AppKit's state restoration, which is
        // why the Mac has no code for it; Windows has no equivalent, so without
        // this every launch snapped back to the 800x600 in tauri.conf.json.
        //
        // Size, position and maximised only. Deliberately not VISIBLE: this
        // window is hidden rather than closed — by the tray, the summon hotkey
        // and hide-on-focus-loss — so restoring that would mean quitting while
        // hidden opens the app to nothing at all next time, with only the tray
        // to explain where it went.
        //
        // The pinned popover is excluded because its position is not the user's
        // to keep: it is placed against the tray each time it opens, and a
        // remembered position would drag it away from the icon it belongs to.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&[PINNED_WINDOW])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // The Index the user last chose, or the default on a fresh install.
            // A saved path can go unreachable — a folder on a drive that isn't
            // plugged in — so a failure to open it falls back to the default
            // rather than refusing to start. The default itself is created on
            // demand by `open`, so it can't fail the same way.
            let mut dir = persisted_index_directory(app.handle());
            let store = match NoteStore::open(&dir, false) {
                Ok(store) => store,
                Err(_) => {
                    dir = default_index_directory();
                    save_index_directory(app.handle(), &dir);
                    NoteStore::open(&dir, false)?
                }
            };
            // A brand-new Index gets a welcome note, so the first launch isn't
            // an empty window with no hint of what to type.
            if store.notes().is_empty() {
                let welcome = dir.join("Welcome to Envy.md");
                if !welcome.exists() {
                    std::fs::write(&welcome, WELCOME_NOTE)?;
                }
            }
            seed_sample_templates_if_needed(app.handle(), &dir);

            let store = NoteStore::open(&dir, false)?;

            // The launch check is driven by the frontend now (main.ts, gated on
            // the "Check for updates automatically" setting), so it isn't spawned
            // here. That keeps one owner for the toggle — the frontend, which is
            // where the setting lives — rather than splitting it across a file
            // the Rust side would also have to read.

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
                pinned_note: Mutex::new(None),
                suppress_until,
                _watcher: Mutex::new(watcher),
                global_shortcuts: Mutex::new(std::collections::HashMap::new()),
                template_date_format: Mutex::new("yyyy-MM-dd".to_string()),
                popouts: Mutex::new(std::collections::HashMap::new()),
            });

            setup_global_hotkey(app.handle())?;
            setup_tray(app.handle())?;
            // Re-assert the remembered on-top state now the window exists.
            apply_keep_on_top(app.handle(), persisted_keep_on_top(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            index_directory,
            search,
            read_note,
            resolve_title,
            save_note,
            create_note,
            extract_to_note,
            list_subfolders,
            move_note_to_subfolder,
            create_note_in_subfolder,
            folder_catalog,
            tag_catalog,
            rename_folder,
            rename_tag,
            open_external_url,
            open_link,
            rename_note,
            delete_note,
            delete_notes,
            restore_last_deleted,
            can_restore,
            trashed_notes,
            restore_from_trash,
            delete_from_trash,
            empty_trash,
            check_for_updates,
            reveal_folder,
            set_index_directory,
            set_template_date_format,
            interlinks,
            list_templates,
            create_note_from_template,
            read_template,
            save_template,
            create_inbox_note,
            inbox_count,
            vault_counts,
            keep_on_top,
            all_tags,
            all_titles,
            submit_from_inbox,
            set_include_subfolders,
            reveal_index,
            reveal_note,
            convert_to_template,
            autostart_enabled,
            set_autostart,
            set_global_shortcuts,
            set_show_in_taskbar,
            pinned_note_id,
            set_pinned_note,
            open_in_main_window,
            pop_out_note,
            popout_note_id,
            reload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The starter templates seeded into Templates/ on first launch, transcribed
/// from the Mac's `TemplateContent.samples`.
///
/// The Daily Notes template carries `{{date}}` in its *name*, not just its
/// body, so a note made from it is titled "Daily Notes July 11, 2026" straight
/// away rather than leaving a "Daily Notes" to rename by hand every day.
/// `create_from_template` already substitutes the placeholders in both.
const SAMPLE_TEMPLATES: [(&str, &str); 3] = [
    (
        "Daily Notes {{date}}",
        "# {{date}}\n\n## Top Priorities\n-\n\n## Notes\n\n\n## Follow Up\n-",
    ),
    ("To-Do List", "# {{title}}\n\n- [ ]\n- [ ]\n- [ ]"),
    (
        "Study Notes",
        "# {{title}}\n\n## Key Concepts\n\n\n## Questions\n\n\n## Summary\n",
    ),
];

/// Writes the starter templates once, on the first launch that ever runs.
///
/// Gated on a marker file rather than on the Templates folder being empty,
/// which matters: emptiness would put the samples back every time someone
/// deleted them, and deleting a template you did not ask for should stick. The
/// Mac gates on a `hasSeededSampleTemplates` flag for the same reason.
///
/// The marker is written *before* the templates, as the Mac sets its flag
/// before writing too — if a write fails, one missing template is a far better
/// outcome than trying again on every launch forever.
fn seed_sample_templates_if_needed(app: &tauri::AppHandle, dir: &Path) {
    let Ok(config) = app.path().app_config_dir() else {
        return;
    };
    let marker = config.join("seeded-templates");
    if marker.exists() {
        return;
    }
    if std::fs::create_dir_all(&config).is_err() || std::fs::write(&marker, "").is_err() {
        return;
    }
    let templates = dir.join("Templates");
    if std::fs::create_dir_all(&templates).is_err() {
        return;
    }
    for (name, body) in SAMPLE_TEMPLATES {
        let path = templates.join(format!("{name}.md"));
        // Never overwrite: a file already under this name is the user's.
        if !path.exists() {
            let _ = std::fs::write(&path, body);
        }
    }
}

const WELCOME_NOTE: &str = r#"# Welcome to Envy

Envy is one search box. Type to filter, press Return to open the top match —
or to create a new note from whatever you typed if nothing matches.

Every note is a plain `.md` file in one folder called The Index. No database,
no proprietary format. Open them in anything.

## Try it

- **Bold**, *italic*, ~~struck through~~, and `code` all render as you type.
- ==highlight== marks text with a background, like ==this==.
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
