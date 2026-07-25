import { EditorView, keymap, drawSelection, rectangularSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import { envyStyler } from './styler'
import { applyTheme, enviousDark } from './theme'

interface NoteDto {
  id: string
  title: string
  preview: string
  content: string | null
  modifiedMs: number
  due: string | null
  dueCount: number
  tags: string[]
  isInbox: boolean
  aiProvenance: 'none' | 'created' | 'edited'
  hasUncheckedTask: boolean
}

const searchInput = document.getElementById('search') as HTMLInputElement
const panesEl = document.getElementById('panes')!
const dividerEl = document.getElementById('divider')!
const listEl = document.getElementById('list')!
const countEl = document.getElementById('count')!
const titleEl = document.getElementById('note-title')!
const dueEl = document.getElementById('note-due')!
const editorEl = document.getElementById('editor')!
const emptyEl = document.getElementById('empty-state')!

let results: NoteDto[] = []
let highlighted = 0
let openNoteId: string | null = null
/// Saves are debounced rather than fired per keystroke — the store writes the
/// whole file atomically, and doing that on every character would be pointless
/// disk churn. 400ms matches the reload debounce in the Mac's NoteStore.
let saveTimer: number | undefined

const editable = new Compartment()

const view = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      history(),
      drawSelection(),
      rectangularSelection(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      envyStyler,
      editable.of(EditorView.editable.of(false)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && openNoteId) scheduleSave()
      }),
      // Alt+Up from the editor goes back to the search box — the keyboard path
      // between panes the Mac app has on ⌥↑.
      keymap.of([
        {
          key: 'Alt-ArrowUp',
          run: () => {
            searchInput.focus()
            searchInput.select()
            return true
          },
        },
      ]),
    ],
  }),
  parent: editorEl,
})

// --- Layout -----------------------------------------------------------------
// Vertical (list above, note below) is the default and the layout the app is
// really built around; horizontal is the alternate. Mirrors the Mac's
// `layoutMode` defaulting to `.vertical` with a 0.6 top fraction.

type LayoutMode = 'vertical' | 'horizontal'

const DEFAULT_TOP_FRACTION = 0.6
const DEFAULT_LIST_WIDTH = 280
const MIN_LIST_WIDTH = 220

function storedNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

let layoutMode: LayoutMode =
  (localStorage.getItem('layoutMode') as LayoutMode | null) ?? 'vertical'

function applyLayout() {
  panesEl.className = layoutMode
  if (layoutMode === 'vertical') {
    const fraction = storedNumber('verticalSplitFraction', DEFAULT_TOP_FRACTION)
    listEl.style.height = `${(fraction * 100).toFixed(3)}%`
    listEl.style.width = ''
  } else {
    const width = storedNumber('horizontalListWidth', DEFAULT_LIST_WIDTH)
    listEl.style.width = `${width}px`
    listEl.style.height = ''
  }
  localStorage.setItem('layoutMode', layoutMode)
  // The editor's viewport just changed shape, and the styler decorates only
  // what's visible.
  view.requestMeasure()
}

function toggleLayout() {
  layoutMode = layoutMode === 'vertical' ? 'horizontal' : 'vertical'
  applyLayout()
}

dividerEl.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  dividerEl.setPointerCapture(e.pointerId)
  dividerEl.classList.add('dragging')

  const onMove = (move: PointerEvent) => {
    const box = panesEl.getBoundingClientRect()
    if (layoutMode === 'vertical') {
      // Clamped so neither pane can be dragged away entirely — a zero-height
      // list or editor is a state there's no way back out of by dragging.
      const fraction = Math.min(0.9, Math.max(0.1, (move.clientY - box.top) / box.height))
      localStorage.setItem('verticalSplitFraction', String(fraction))
    } else {
      const width = Math.min(
        box.width - 240,
        Math.max(MIN_LIST_WIDTH, move.clientX - box.left),
      )
      localStorage.setItem('horizontalListWidth', String(width))
    }
    applyLayout()
  }
  const onUp = () => {
    dividerEl.classList.remove('dragging')
    dividerEl.removeEventListener('pointermove', onMove)
    dividerEl.removeEventListener('pointerup', onUp)
  }
  dividerEl.addEventListener('pointermove', onMove)
  dividerEl.addEventListener('pointerup', onUp)
})

function scheduleSave() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(save, 400)
}

async function save() {
  if (!openNoteId) return
  try {
    await invoke('save_note', { id: openNoteId, content: view.state.doc.toString() })
  } catch (e) {
    console.error('save failed', e)
  }
}

function dueUrgencyClass(iso: string): string {
  const due = new Date(iso + 'T00:00:00')
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (due < today) return 'overdue'
  // End of the current calendar week, matching envy-core's urgency_for.
  const weekEnd = new Date(today.getTime() + (6 - today.getDay()) * 86400000)
  return due <= weekEnd ? 'soon' : 'later'
}

/// Matches the Mac's `showNotePreview` default. Opt-in rather than always-on:
/// the compact one-line row is what the list is designed around.
const showNotePreview = localStorage.getItem('showNotePreview') === 'true'

/// The "smart" date style: a time for today, a weekday within the last week,
/// month/day within this year, and a full date beyond that.
function formatModified(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayOf = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const days = Math.round((today.getTime() - dayOf.getTime()) / 86400000)

  if (days === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDue(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((d.getTime() - today.getTime()) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  // Weekday names for the coming week, as the Mac does.
  if (days > 1 && days < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function renderList() {
  countEl.textContent = results.length ? String(results.length) : ''
  listEl.replaceChildren(
    ...results.map((note, i) => {
      const row = document.createElement('div')
      row.className = 'row' + (i === highlighted ? ' highlighted' : '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === highlighted))

      const title = document.createElement('div')
      title.className = 'row-title'
      title.textContent = note.title

      // A fleeting note is marked with an amber dot. The folder it sits in is
      // the only thing that makes it fleeting, so this is derived, not stored.
      if (note.isInbox) {
        const dot = document.createElement('span')
        dot.className = 'inbox-dot'
        dot.title = 'Fleeting note'
        title.prepend(dot)
      }
      if (note.aiProvenance !== 'none') {
        const badge = document.createElement('span')
        badge.className = 'ai-badge'
        badge.textContent = '⎈'
        // "Marked as", never asserted — it's a self-attested claim Envy can't
        // verify, same wording rule as the Mac.
        badge.title = `Marked as ${note.aiProvenance} by an AI assistant`
        title.append(badge)
      }

      row.append(title)

      if (note.due) {
        const pill = document.createElement('span')
        pill.className = `row-due envy-due-${dueUrgencyClass(note.due)}`
        pill.textContent = formatDue(note.due)
        // A note with several due dates shouldn't look like it has only the
        // soonest one.
        if (note.dueCount > 1) pill.textContent += ` +${note.dueCount - 1}`
        row.append(pill)
      }

      // showDateModified defaults to true on the Mac; showNotePreview defaults
      // to false. So the default row is one dense line — title, due, date —
      // not a two-line card. Preview is opt-in.
      const date = document.createElement('span')
      date.className = 'row-date'
      date.textContent = formatModified(note.modifiedMs)
      row.append(date)

      if (showNotePreview) {
        const meta = document.createElement('div')
        meta.className = 'row-meta'
        meta.textContent = note.preview
        row.append(meta)
      }

      row.onclick = () => {
        highlighted = i
        void openHighlighted()
      }
      return row
    }),
  )
}

async function runSearch() {
  results = await invoke<NoteDto[]>('search', { query: searchInput.value })
  highlighted = 0
  renderList()
}

async function openNote(id: string) {
  // Flush any pending edit to the note we're leaving before switching.
  window.clearTimeout(saveTimer)
  await save()

  const note = await invoke<NoteDto | null>('read_note', { id })
  if (!note) return
  openNoteId = note.id
  titleEl.textContent = note.title
  dueEl.textContent = note.due ? formatDue(note.due) : ''
  dueEl.className = note.due ? `envy-due-${dueUrgencyClass(note.due)}` : ''
  emptyEl.classList.add('hidden')
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: note.content ?? '' },
    effects: editable.reconfigure(EditorView.editable.of(true)),
    selection: { anchor: 0 },
  })
  // The pane's size can change as the empty state is uncovered, and the
  // styler decorates only what's in view — without a re-measure the viewport
  // it computed a moment ago may not match what's actually on screen.
  view.requestMeasure()
}

async function openHighlighted() {
  const target = results[highlighted]
  if (!target) return
  await openNote(target.id)
  renderList()
}

/// Return opens the top match, or creates a note from the search text when
/// nothing matches — the single interaction the whole app is built around.
async function openOrCreate() {
  const query = searchInput.value.trim()
  if (results.length > 0) {
    await openHighlighted()
    view.focus()
    return
  }
  if (!query) return
  const created = await invoke<NoteDto>('create_note', { title: query })
  searchInput.value = ''
  await runSearch()
  await openNote(created.id)
  renderList()
  view.focus()
}

searchInput.addEventListener('input', () => void runSearch())

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlighted = Math.min(highlighted + 1, results.length - 1)
    renderList()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlighted = Math.max(highlighted - 1, 0)
    renderList()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    void openOrCreate()
  } else if (e.key === 'Escape') {
    searchInput.value = ''
    void runSearch()
  }
})

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return
  const key = e.key.toLowerCase()
  // Ctrl+Shift+L toggles vertical / horizontal, the Windows spelling of ⌘⇧L.
  // Checked before plain Ctrl+L, which would otherwise swallow it.
  if (e.shiftKey && key === 'l') {
    e.preventDefault()
    toggleLayout()
  } else if (key === 'l') {
    // Ctrl+L jumps to the search box from anywhere — the Mac's ⌘L.
    e.preventDefault()
    searchInput.focus()
    searchInput.select()
  }
})

window.addEventListener('resize', () => view.requestMeasure())

// No file watcher yet, so a note edited in another app is picked up when the
// window regains focus. The watcher will make this automatic.
window.addEventListener('focus', async () => {
  await invoke('reload')
  await runSearch()
})

async function boot() {
  applyTheme(enviousDark)
  applyLayout()
  const dir = await invoke<string>('index_directory')
  searchInput.placeholder = `Search ${dir}…`
  await runSearch()
  searchInput.focus()
}

// Exposed for debugging the styler from the webview console — the decoration
// pass is viewport-dependent, so reproducing a problem usually means driving
// the real view rather than reasoning about the regexes in isolation.
;(window as any).__view = view

void boot()
