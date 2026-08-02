//! A popped-out note: a note in its own floating, resizable window, opened from
//! the list's "Pop Out" menu. Several can be open at once. It's a real editing
//! surface — edits save straight to the note — and following a `[[link]]` inside
//! it opens the target in the *main* window rather than swapping the float's
//! content, matching the Mac's pop-out (onNavigate drives the main editor).
//!
//! Shares the styler, theme and list-editing with the main window, so a popped
//! note looks and edits exactly as it does in the app.

import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { envyStyler } from './styler'
import { listEditing } from './lists'
import { applyTheme, enviousDark, enviousLight } from './theme'

// Its own entry point, so it needs its own last-resort handler — the main
// window's doesn't reach here.
window.addEventListener('unhandledrejection', (e) => {
  console.error('pop-out failed silently:', e.reason)
})

interface NoteDto {
  id: string
  title: string
  content: string | null
}

const editorEl = document.getElementById('popout-editor')!
let noteId: string | null = null
let savedContent = ''
let saveTimer: number | undefined
// Shared with the main window through the common origin's localStorage; default
// on, so a plain click still places the caret to edit a link.
const requireModifier = localStorage.getItem('requireModifierForLinkClick') !== 'false'

/// The `[[…]]` target at a position, alias and heading stripped — the same
/// resolution the main window's follow uses.
function wikiLinkTargetAt(v: EditorView, pos: number): string | null {
  const line = v.state.doc.lineAt(pos)
  const re = /!?\[\[([^\[\]]+)\]\]/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) {
      const target = m[1].split('|')[0].split('#')[0].trim()
      return target || null
    }
  }
  return null
}

const view = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      history(),
      drawSelection(),
      listEditing,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      envyStyler,
      EditorView.domEventHandlers({
        mousedown: (event, v) => {
          if (event.button !== 0) return false
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          // Honour the same modifier gate as the main editor, so a plain click
          // can still land the caret inside a link to edit it.
          if (requireModifier && !event.ctrlKey) return false
          const target = wikiLinkTargetAt(v, pos)
          if (!target) return false
          event.preventDefault()
          void followInMain(target)
          return true
        },
      }),
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

/// Following a link opens the target in the main window (creating it if needed),
/// bringing that window forward — the float stays put on whatever it was
/// showing, as a reference you keep beside your work.
async function followInMain(target: string) {
  await flush()
  try {
    const note = await invoke<NoteDto>('open_link', { target })
    await invoke('open_in_main_window', { id: note.id })
  } catch (e) {
    console.error('could not follow the link', e)
  }
}

async function save() {
  if (!noteId) return
  const content = view.state.doc.toString()
  if (content === savedContent) return
  try {
    await invoke('save_note', { id: noteId, content })
    savedContent = content
  } catch (e) {
    console.error('pop-out save failed', e)
  }
}

async function load() {
  try {
    const id = await invoke<string | null>('popout_note_id')
    if (!id) return
    const note = await invoke<NoteDto | null>('read_note', { id })
    if (!note) return
    noteId = note.id
    savedContent = note.content ?? ''
    document.title = note.title
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: savedContent },
      selection: { anchor: 0 },
    })
  } catch (e) {
    console.error('could not load the popped-out note', e)
  }
}

async function flush() {
  window.clearTimeout(saveTimer)
  await save()
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
function syncTheme() {
  const stored = localStorage.getItem('appearanceMode') ?? 'system'
  const dark = stored === 'system' ? darkQuery.matches : stored === 'dark'
  applyTheme(dark ? enviousDark : enviousLight)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
darkQuery.addEventListener('change', syncTheme)
// Applied up front, before any Tauri call — a hiccup in the window API must
// never leave the note rendered with no theme (an unset --envy-background is a
// blank white page).
syncTheme()

// Escape closes the float (after flushing) — the same quick dismissal the peek
// and pinned popover offer. The native title bar's close button closes it too.
// (No onCloseRequested handler: an async close listener deferred the native
// close, so the window wouldn't shut. The 400ms save debounce and this flush
// cover the pending edit instead.)
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  e.preventDefault()
  void flush().then(() => getCurrentWindow().close())
})

void load()
view.focus()
