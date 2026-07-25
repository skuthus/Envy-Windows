//! The pinned-note popover.
//!
//! A second, small, always-on-top window showing one note, opened by clicking
//! the tray icon. The whole point is that it appears *without* summoning the
//! app: a scratchpad one click away, which is what the Mac's menu-bar pinned
//! note is for. Summoning the main window to read a two-line note would defeat
//! the purpose.
//!
//! It shares the styler and theme with the main window, so a pinned note looks
//! exactly like it does in the app — same markdown rendering, same colours.

import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { envyStyler } from './styler'
import { applyTheme, enviousDark, enviousLight } from './theme'

interface NoteDto {
  id: string
  title: string
  content: string | null
}

const titleEl = document.getElementById('pinned-title')!
const editorEl = document.getElementById('pinned-editor')!

let noteId: string | null = null
let savedContent = ''
let saveTimer: number | undefined

const view = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      history(),
      drawSelection(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      envyStyler,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && noteId) {
          window.clearTimeout(saveTimer)
          saveTimer = window.setTimeout(() => {
            saveTimer = undefined
            void save()
          }, 400)
        }
      }),
    ],
  }),
  parent: editorEl,
})

async function save() {
  if (!noteId) return
  const content = view.state.doc.toString()
  // Same guard as the main window: an identical rewrite would touch the
  // modified time and reshuffle the list for nothing.
  if (content === savedContent) return
  try {
    await invoke('save_note', { id: noteId, content })
    savedContent = content
  } catch (e) {
    console.error('pinned save failed', e)
  }
}

async function load() {
  const id = await invoke<string | null>('pinned_note_id')
  if (!id) {
    titleEl.textContent = 'No note pinned'
    return
  }
  const note = await invoke<NoteDto | null>('read_note', { id })
  if (!note) {
    titleEl.textContent = 'Pinned note is gone'
    return
  }
  noteId = note.id
  savedContent = note.content ?? ''
  titleEl.textContent = note.title
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: savedContent },
    selection: { anchor: 0 },
  })
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
function syncTheme() {
  const stored = localStorage.getItem('appearanceMode') ?? 'system'
  const dark = stored === 'system' ? darkQuery.matches : stored === 'dark'
  applyTheme(dark ? enviousDark : enviousLight)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
darkQuery.addEventListener('change', syncTheme)

// Flush before the window goes away — hiding is the normal way this closes,
// and a pending debounce would otherwise be dropped along with it.
async function flush() {
  window.clearTimeout(saveTimer)
  await save()
}

/// Hiding is deliberately allowed to fail without taking the caller with it.
///
/// It failed silently once already: capabilities are per-window, this window
/// wasn't listed in one, and `hide()` was rejected at runtime. Because both
/// buttons awaited the hide *before* doing their work, the rejection killed
/// the action and neither button appeared to do anything at all. The work now
/// happens first, and a hide that fails is logged rather than swallowed.
async function hide() {
  try {
    await getCurrentWindow().hide()
  } catch (e) {
    console.error('could not hide the pinned window', e)
  }
}

document.getElementById('pinned-unpin')!.onclick = async () => {
  await flush()
  try {
    await invoke('set_pinned_note', { id: null })
  } catch (e) {
    console.error('unpin failed', e)
  }
  await hide()
}

document.getElementById('pinned-open')!.onclick = async () => {
  await flush()
  try {
    if (noteId) await invoke('open_in_main_window', { id: noteId })
  } catch (e) {
    console.error('open failed', e)
  }
  await hide()
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void flush().then(hide)
})

// Re-read on every show: the note may have changed in the app, or been
// swapped for a different one, since this window was last visible.
void listen('pinned-note-changed', () => void load())

syncTheme()
void load()
view.focus()
