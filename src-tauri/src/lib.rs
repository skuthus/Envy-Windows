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
use tauri::menu::{Menu, MenuItem};
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

/// Re-reads the Index from disk. Called on window focus for now — the file
/// watcher will make this automatic, but until then focusing the window after
/// editing a note elsewhere is enough to pick the change up.
#[tauri::command]
fn reload(state: State<AppState>) -> usize {
    let mut store = state.store.lock().unwrap();
    store.reload();
    store.notes().len()
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
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let summon = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Enter);
    let handle = app.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                // Fire on press only; without this the chord toggles twice per
                // use and lands back where it started.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::Enter) {
                    if let Some(window) = handle.get_webview_window("main") {
                        toggle_window(&window);
                    }
                }
            })
            .build(),
    )?;

    if let Err(e) = app.global_shortcut().register(summon) {
        eprintln!("could not register the summon hotkey (Ctrl+Alt+Enter): {e}");
    }
    Ok(())
}

/// The notification-area icon — Windows' counterpart to the Mac's menu bar
/// item. Left click toggles the window, exactly as the hotkey does; the menu
/// is for the things a click can't express.
fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show Envy", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Envy", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().ok_or("no window icon")?)
        .tooltip("Envy")
        .menu(&menu)
        // Without this a left click opens the menu instead of reaching the
        // click handler, and the single most common gesture would be wrong.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
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
fn toggle_window(window: &WebviewWindow) {
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
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
                suppress_until,
                _watcher: Mutex::new(watcher),
            });

            setup_global_hotkey(app.handle())?;
            setup_tray(app.handle())?;
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
            interlinks,
            list_templates,
            read_template,
            save_template,
            create_inbox_note,
            set_include_subfolders,
            reveal_index,
            autostart_enabled,
            set_autostart,
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
