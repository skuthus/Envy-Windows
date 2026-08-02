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
import { listEditing } from './lists'
import { applyTheme, enviousDark, enviousLight } from './theme'

// This window is where the silent-failure pattern first bit — see `hide()`
// below. Its own entry point, so it needs its own handler; the main window's
// does not cover it.
window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandled rejection — something failed silently:', e.reason)
})

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
// Shared with the main window through the common origin's localStorage.
const requireModifier = localStorage.getItem('requireModifierForLinkClick') !== 'false'

/// The `[[…]]` target at a position — alias and heading stripped, as the main
/// window resolves it.
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

/// Following a link opens the target in the main window (creating it if
/// needed) — the same drive-the-main-editor behaviour the pop-out has. Bringing
/// the main window forward blurs this popover, which then hides itself unless
/// it's been kept open.
async function followInMain(target: string) {
  await flush()
  try {
    const note = await invoke<NoteDto>('open_link', { target })
    await invoke('open_in_main_window', { id: note.id })
  } catch (e) {
    console.error('could not follow the link', e)
  }
}

const view = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      history(),
      drawSelection(),
      // List continuation / indent / renumber, as in the main and pop-out
      // editors.
      listEditing,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      envyStyler,
      EditorView.domEventHandlers({
        mousedown: (event, v) => {
          if (event.button !== 0) return false
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
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
/// It failed silently once already, and for longer than first diagnosed. The
/// original reading was that this window was missing from a capability's
/// `windows` list — true, and necessary to fix, but not the whole cause.
/// `hide()` also needs `core:window:allow-hide` named explicitly: `core:default`
/// sounds comprehensive but its window half covers only the read-only calls, so
/// hiding was still being rejected after the window was listed. Because both
/// buttons awaited the hide *before* doing their work, the rejection killed the
/// action and neither button appeared to do anything; reordering made them work
/// while the hide itself went on failing into this log line, which is precisely
/// what a caught-and-logged error is for.
async function hide() {
  try {
    await getCurrentWindow().hide()
  } catch (e) {
    console.error('could not hide the pinned window', e)
  }
}

// No Unpin button here, matching the Mac: its popover carries the keep-open pin
// and "Open in Envy", nothing else. Unpinning is a thing you do to the tray, not
// something the note's own window should offer — and it stays reachable three
// ways: "Unpin Note" in the tray menu, "Unpin from Tray" on the note's context
// menu, and Ctrl+Alt+Shift+P from any app.
document.getElementById('pinned-open')!.onclick = async () => {
  await flush()
  try {
    if (noteId) await invoke('open_in_main_window', { id: noteId })
  } catch (e) {
    console.error('open failed', e)
  }
  await hide()
}

// --- Keep open ---------------------------------------------------------------
// The Mac's panel closes as soon as focus moves elsewhere, unless its pin
// button is on — that button is the whole reason the behaviour exists. This
// window had neither half: it never closed on its own, which is the pinned-open
// state permanently, so adding the toggle alone would have changed nothing.

let keepOpen = localStorage.getItem('menuBarPopoverPinnedOpen') === 'true'
const keepOpenEl = document.getElementById('pinned-keep-open') as HTMLButtonElement

function renderKeepOpen() {
  keepOpenEl.classList.toggle('active', keepOpen)
  keepOpenEl.title = keepOpen
    ? 'Keeping this window open — click to let it close when you click elsewhere'
    : 'Keep this window open and on top, even when you click elsewhere'
}

keepOpenEl.onclick = () => {
  keepOpen = !keepOpen
  localStorage.setItem('menuBarPopoverPinnedOpen', String(keepOpen))
  renderKeepOpen()
}
renderKeepOpen()

// Closing on blur is what the pin suppresses. The note is flushed first —
// losing focus is not a reason to lose an edit.
try {
  void getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
    if (focused || keepOpen) return
    await flush()
    await hide()
  })
} catch {
  // Running outside Tauri.
}

// --- Zoom --------------------------------------------------------------------
// The popover keeps its own zoom, separate from the editor's. An offset in
// points rather than a multiplier, and clamped to the Mac's own -6…+24.

let popoverZoom = Number(localStorage.getItem('menuBarPopoverFontZoom') ?? '0')
function applyPopoverZoom() {
  const base = Number.parseFloat(enviousDark.fontSize)
  document.documentElement.style.setProperty(
    '--envy-font-size',
    `${(base + popoverZoom).toFixed(2)}px`,
  )
  localStorage.setItem('menuBarPopoverFontZoom', String(popoverZoom))
  view.requestMeasure()
}
function setPopoverZoom(next: number) {
  popoverZoom = Math.max(-6, Math.min(24, next))
  applyPopoverZoom()
}
applyPopoverZoom()

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    void flush().then(hide)
    return
  }
  if (!e.ctrlKey || e.altKey || e.shiftKey) return
  // Ctrl and the same three keys the Mac binds to Command.
  if (e.key === '-') {
    e.preventDefault()
    setPopoverZoom(popoverZoom - 1)
  } else if (e.key === '0') {
    e.preventDefault()
    setPopoverZoom(0)
  } else if (e.key === '=' || e.key === '+') {
    e.preventDefault()
    setPopoverZoom(popoverZoom + 1)
  }
})

// Re-read on every show: the note may have changed in the app, or been
// swapped for a different one, since this window was last visible.
void listen('pinned-note-changed', () => void load())

syncTheme()
void load()
view.focus()
