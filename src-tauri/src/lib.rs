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
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
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

/// Resolves a wiki-link title to a note, without creating one.
///
/// Separate from `open_link`, which creates on miss. An embed pointing at a
/// note that doesn't exist should say so, not quietly bring one into being
/// every time the host note is rendered.
#[tauri::command]
fn resolve_title(title: String, state: State<AppState>) -> Option<NoteDto> {
    let store = state.store.lock().unwrap();
    store
        .exact_title_match(&title)
        .map(|n| NoteDto::from_note(n, true))
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
    let Some(mut note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    note.set_content(content);
    store.save(&note).map_err(|e| e.to_string())?;
    store
        .notes()
        .iter()
        .find(|n| n.id() == id)
        .map(|n| NoteDto::from_note(n, false))
        .ok_or_else(|| format!("note {id} vanished during save"))
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

/// Notes currently sitting in any `.trash` folder, filtered by the text typed
/// after `trash:`. An empty fragment matches everything, the same way
/// `template:` shows every template until you narrow it.
///
/// Content is included: the trash preview shows the note's text, and a trashed
/// note is not in `notes()`, so `read_note` cannot reach it.
#[tauri::command]
fn trashed_notes(fragment: String, state: State<AppState>) -> Vec<NoteDto> {
    let needle = fragment.trim().to_lowercase();
    state
        .store
        .lock()
        .unwrap()
        .trashed_notes()
        .iter()
        .filter(|n| needle.is_empty() || n.lowercased_title().contains(&needle))
        .map(|n| NoteDto::from_note(n, true))
        .collect()
}

#[tauri::command]
fn restore_from_trash(id: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.trashed_notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no trashed note with id {id}"));
    };
    store
        .restore_from_trash(&note)
        .map(|n| NoteDto::from_note(&n, false))
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

/// Deletes trashed notes older than `max_age_days`, for the scheduled sweep.
///
/// Age is the file's modification time, which for a trashed note is when it
/// was deleted — moving a file doesn't touch it. Returns how many went.
///
/// Runs on launch rather than on a timer. A note-taking app is not reliably
/// running when a timer would fire, and "swept the next time you opened Envy"
/// is both easier to reason about and impossible to miss.
#[tauri::command]
fn sweep_trash(max_age_days: u64, state: State<AppState>) -> usize {
    if max_age_days == 0 {
        return 0;
    }
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(max_age_days * 24 * 60 * 60);
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let stale: Vec<_> = store
        .trashed_notes()
        .iter()
        .filter(|n| n.modified < cutoff)
        .cloned()
        .collect();
    for note in &stale {
        store.delete_from_trash(note);
    }
    stale.len()
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
    store
        .restore_last_deleted()
        .iter()
        .map(|n| NoteDto::from_note(n, false))
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
        .map(|n| NoteDto::from_note(&n, true))
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

/// Files a fleeting note into the Index proper — a plain move out of `Inbox/`.
/// The note's text is untouched, so nothing about having been fleeting
/// survives in the file.
#[tauri::command]
fn submit_from_inbox(id: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store
        .submit_from_inbox(&note)
        .map(|n| NoteDto::from_note(&n, true))
        .ok_or_else(|| "that note is not in the Inbox".to_string())
}

#[tauri::command]
fn create_inbox_note(title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    store
        .create_inbox_note(&title)
        .map(|n| NoteDto::from_note(&n, true))
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
#[tauri::command]
fn reveal_note(id: String, state: State<AppState>) -> Result<(), String> {
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
        .arg(format!("/select,{}", path.display()))
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

    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Envy", true, None::<&str>)?;

    Ok(Menu::with_items(
        app,
        &[
            &new_note,
            &new_pinned,
            &template_submenu,
            &unpin,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &quit,
        ],
    )?)
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
                "settings" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                        let _ = w.emit("open-settings", ());
                    }
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
        // The search box is where a summon should land — the point of
        // summoning is to type.
        let _ = window.emit("focus-search", ());
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

/// Whether the app launches at login.
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
                pinned_note: Mutex::new(None),
                suppress_until,
                _watcher: Mutex::new(watcher),
                global_shortcuts: Mutex::new(std::collections::HashMap::new()),
                template_date_format: Mutex::new("yyyy-MM-dd".to_string()),
            });

            setup_global_hotkey(app.handle())?;
            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            index_directory,
            search,
            read_note,
            resolve_title,
            save_note,
            create_note,
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
            sweep_trash,
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
            all_tags,
            submit_from_inbox,
            set_include_subfolders,
            reveal_index,
            reveal_note,
            convert_to_template,
            autostart_enabled,
            set_autostart,
            set_global_shortcuts,
            pinned_note_id,
            set_pinned_note,
            open_in_main_window,
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
