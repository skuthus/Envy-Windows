import { EditorView, keymap, drawSelection, rectangularSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { envyStyler } from './styler'
import { applyTheme, enviousDark, enviousLight } from './theme'

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
/// The split sizes the *pane* (header + scrolling list), not the list itself —
/// the list is `flex: 1` inside it. Sizing the inner element instead leaves
/// the pane fixed at its CSS height, which reads as a divider that won't drag.
const listPaneEl = document.getElementById('list-pane')!
const listEl = document.getElementById('list')!
const listHeaderEl = document.getElementById('list-header')!
const countEl = document.getElementById('count')!
const titleEl = document.getElementById('note-title') as HTMLInputElement
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
      EditorView.domEventHandlers({
        mousedown: (event, v) => {
          // Ctrl+click follows a link, the Windows spelling of ⌘-click. Envy
          // requires a modifier by default (`requireModifierForLinkClick`) so
          // an ordinary click can still place the cursor inside a link to
          // edit it — the two gestures would otherwise fight.
          if (!event.ctrlKey || event.button !== 0) return false
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          const target = wikiLinkTargetAt(v, pos)
          if (!target) return false
          event.preventDefault()
          void followLink(target)
          return true
        },
      }),
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

// --- Wiki-links -------------------------------------------------------------

/// The link target under `pos`, or null if the position isn't inside one.
///
/// Scans the clicked line rather than consulting the decorations: the styler's
/// ranges aren't addressable after the fact, and a line is short enough that
/// re-matching it costs nothing. Handles `![[embed]]` too — the leading `!`
/// changes how it renders, not where it points.
function wikiLinkTargetAt(v: EditorView, pos: number): string | null {
  const line = v.state.doc.lineAt(pos)
  const re = /!?\[\[([^\[\]]+)\]\]/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) {
      // Strip an alias or heading suffix — `[[Note|shown]]` points at `Note`,
      // and `[[Note#Heading]]` resolves to the note. Mirrors WikiLink::parse.
      const body = m[1]
      const target = body.split('|')[0].split('#')[0].trim()
      return target || null
    }
  }
  return null
}

async function followLink(target: string) {
  // Flush the current note first: following a link that creates a note causes
  // a rescan, and an unsaved buffer would be read back stale.
  cancelPendingSave()
  await save()
  const note = await invoke<NoteDto>('open_link', { target })
  await runSearch()
  await openNote(note.id)
  highlighted = results.findIndex((n) => n.id === note.id)
  if (highlighted < 0) highlighted = 0
  renderList()
  view.focus()
}

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
    listPaneEl.style.height = `${(fraction * 100).toFixed(3)}%`
    listPaneEl.style.width = ''
  } else {
    const width = storedNumber('horizontalListWidth', DEFAULT_LIST_WIDTH)
    listPaneEl.style.width = `${width}px`
    listPaneEl.style.height = ''
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
  cancelPendingSave()
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined
    void save()
  }, 400)
}

/// Clearing the handle is not bookkeeping pedantry: `saveTimer === undefined`
/// is what "no unsaved keystrokes in flight" is read from, and a stale handle
/// would make the watcher refuse to ever refresh the open note.
function cancelPendingSave() {
  window.clearTimeout(saveTimer)
  saveTimer = undefined
}

async function save() {
  if (!openNoteId) return
  try {
    const saved = await invoke<NoteDto>('save_note', {
      id: openNoteId,
      content: view.state.doc.toString(),
    })
    applySavedNote(saved)
  } catch (e) {
    console.error('save failed', e)
  }
}

/// Folds a just-saved note's freshly derived values back into the list and the
/// title bar. Adding, changing, or deleting an `@due` token changes the pill,
/// the row, and possibly the sort position — none of which the watcher will
/// report, since a write suppresses it on purpose.
function applySavedNote(saved: NoteDto) {
  const idx = results.findIndex((n) => n.id === saved.id)
  if (idx >= 0) {
    // Keep the content field: `results` entries carry it as null by design,
    // and the row only reads derived values anyway.
    results[idx] = { ...saved, content: null }
  }
  if (openNoteId === saved.id) renderDueBadge(saved.due)
  // Re-render so a changed due date or modified time moves the row under the
  // current sort. The open note keeps the highlight across the reorder.
  const keepId = results[highlighted]?.id ?? openNoteId
  renderList()
  const moved = results.findIndex((n) => n.id === keepId)
  if (moved >= 0 && moved !== highlighted) {
    highlighted = moved
    renderList()
  }
}

function renderDueBadge(due: string | null) {
  dueEl.textContent = due ? formatDue(due) : ''
  dueEl.className = due ? `envy-due-${dueUrgencyClass(due)}` : ''
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

// --- Settings ---------------------------------------------------------------
// Defaults match the Mac's @AppStorage defaults exactly. `showNotePreview` is
// off because the compact one-line row is what the list is designed around.

function boolSetting(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key)
  return raw === null ? fallback : raw === 'true'
}

const settings = {
  showNotePreview: boolSetting('showNotePreview', false),
  showDateModified: boolSetting('showDateModified', true),
  showDueSort: boolSetting('showDueSort', true),
  includeSubfolders: boolSetting('indexIncludeSubfolders', false),
  theme: localStorage.getItem('appearanceMode') ?? 'system',
}

function saveSetting(key: string, value: string | boolean) {
  localStorage.setItem(key, String(value))
}

// --- Sorting ----------------------------------------------------------------

type SortField = 'name' | 'date' | 'due'

/// The direction each field starts in when first selected — Notational
/// Velocity's convention (names A→Z, dates newest first). Due defaults
/// ascending so the most urgent note is at the top, the same reasoning as
/// names starting A→Z rather than Z→A.
const DEFAULT_ASCENDING: Record<SortField, boolean> = {
  name: true,
  date: false,
  due: true,
}

let sortField: SortField = (localStorage.getItem('noteSortField') as SortField | null) ?? 'date'
let sortAscending = boolSetting('noteSortAscending', false)

/// Applied after filtering, replacing relevance order entirely — same as the
/// Mac, where sortNotes runs on the already-filtered list.
function sortNotes(notes: NoteDto[]): NoteDto[] {
  const dir = sortAscending ? 1 : -1
  const sorted = [...notes]
  switch (sortField) {
    case 'name':
      // `numeric` approximates localizedStandardCompare, so "Note 2" sorts
      // before "Note 10" rather than after it.
      sorted.sort(
        (a, b) => dir * a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
      )
      break
    case 'date':
      sorted.sort((a, b) => dir * (a.modifiedMs - b.modifiedMs))
      break
    case 'due':
      // An undated note always sorts to the end, whichever direction is
      // chosen — "no due date" isn't smaller or larger than a date, it's
      // absent, and having undated notes bury dated ones (or the reverse)
      // depending on which arrow is clicked would be surprising either way.
      sorted.sort((a, b) => {
        if (!a.due && !b.due) return 0
        if (!a.due) return 1
        if (!b.due) return -1
        return dir * a.due.localeCompare(b.due)
      })
      break
  }
  return sorted
}

function renderSortHeader() {
  const fields: Array<[SortField, string]> = [
    ['name', 'Name'],
    ...(settings.showDueSort ? ([['due', 'Due']] as Array<[SortField, string]>) : []),
    ...(settings.showDateModified ? ([['date', 'Date']] as Array<[SortField, string]>) : []),
  ]
  listHeaderEl.replaceChildren(
    ...fields.map(([field, label]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sort-button' + (sortField === field ? ' active' : '')
      b.dataset.field = field
      b.textContent = label
      if (sortField === field) {
        const arrow = document.createElement('span')
        arrow.className = 'sort-arrow'
        arrow.textContent = sortAscending ? '▲' : '▼'
        b.append(arrow)
      }
      b.onclick = () => {
        if (sortField === field) {
          sortAscending = !sortAscending
        } else {
          sortField = field
          sortAscending = DEFAULT_ASCENDING[field]
        }
        saveSetting('noteSortField', sortField)
        saveSetting('noteSortAscending', sortAscending)
        renderSortHeader()
        renderList()
      }
      return b
    }),
  )
}

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
  results = sortNotes(results)
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
      if (settings.showDateModified) {
        const date = document.createElement('span')
        date.className = 'row-date'
        date.textContent = formatModified(note.modifiedMs)
        row.append(date)
      }

      if (settings.showNotePreview) {
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
  cancelPendingSave()
  await save()

  const note = await invoke<NoteDto | null>('read_note', { id })
  if (!note) return
  openNoteId = note.id
  titleEl.value = note.title
  renderDueBadge(note.due)
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

async function deleteHighlighted() {
  const target = results[highlighted]
  if (!target) return
  // Drop the pending save first — it would recreate the file we just trashed.
  cancelPendingSave()
  if (openNoteId === target.id) openNoteId = null
  await invoke('delete_note', { id: target.id })
  if (openNoteId === null) closeEditor()
  await runSearch()
}

async function restoreDeleted() {
  const restored = await invoke<NoteDto[]>('restore_last_deleted')
  await runSearch()
  if (restored.length > 0) {
    highlighted = Math.max(
      0,
      results.findIndex((n) => n.id === restored[0].id),
    )
    renderList()
  }
}

// --- Renaming ---------------------------------------------------------------
// The title bar *is* the rename field — a note's title is its filename, so
// there's nothing else it could edit. Committing runs the store's rename,
// which rewrites every [[link]] and ![[embed]] pointing at the old title
// across the Index.

async function commitRename() {
  if (!openNoteId) return
  const next = titleEl.value.trim()
  const current = results.find((n) => n.id === openNoteId)?.title ?? ''
  if (!next || next === current) {
    titleEl.value = current
    return
  }
  try {
    const renamed = await invoke<NoteDto>('rename_note', { id: openNoteId, title: next })
    openNoteId = renamed.id
    // The sanitizer may have changed what was typed — a title Windows can't
    // represent as a filename comes back altered, and showing the typed text
    // would be a lie about what's on disk.
    titleEl.value = renamed.title
    await runSearch()
    highlighted = Math.max(0, results.findIndex((n) => n.id === renamed.id))
    renderList()
  } catch (e) {
    console.error('rename failed', e)
    titleEl.value = current
  }
}

titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    void commitRename().then(() => view.focus())
  } else if (e.key === 'Escape') {
    e.preventDefault()
    titleEl.value = results.find((n) => n.id === openNoteId)?.title ?? ''
    view.focus()
  }
})
titleEl.addEventListener('blur', () => void commitRename())

function closeEditor() {
  openNoteId = null
  titleEl.value = ''
  dueEl.textContent = ''
  emptyEl.classList.remove('hidden')
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: '' },
    effects: editable.reconfigure(EditorView.editable.of(false)),
  })
}

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return
  const key = e.key.toLowerCase()

  // Ctrl+, opens Settings — the Windows spelling of ⌘,.
  if (key === ',') {
    e.preventDefault()
    if (settingsEl.classList.contains('hidden')) openSettings()
    else closeSettings()
    return
  }

  // Delete is Ctrl+Backspace and restore is Ctrl+Shift+Backspace, matching the
  // Mac's ⌘⌫ / ⌘⇧⌫. Deliberately not the bare Del key, which Windows
  // convention would suggest — inside the editor Del is forward-delete, and a
  // shortcut that destroys the note you're typing in depending on focus is a
  // bad trade for idiom.
  if (key === 'backspace') {
    e.preventDefault()
    if (e.shiftKey) void restoreDeleted()
    else void deleteHighlighted()
    return
  }
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

// The backend rescans and emits; the frontend re-runs its own query rather
// than being handed results, so a reload can't clobber whatever has since been
// typed into the search box.
void listen('index-changed', async () => {
  await runSearch()
  // Reload the open note too, unless there are unsaved keystrokes in flight —
  // overwriting the buffer someone is typing into is worse than showing them
  // a stale copy for another moment.
  if (openNoteId && saveTimer === undefined) {
    const fresh = await invoke<NoteDto | null>('read_note', { id: openNoteId })
    if (fresh && fresh.content !== null && fresh.content !== view.state.doc.toString()) {
      const cursor = view.state.selection.main.head
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: fresh.content },
        selection: { anchor: Math.min(cursor, fresh.content.length) },
      })
    }
  }
})

// Envious ships a light and a dark face. Following the OS is the default —
// `AppearanceMode.system` on the Mac — but an explicit choice pins it.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
function syncTheme() {
  // Every color is a CSS variable, so swapping the token set is the whole
  // switch — no light-mode stylesheet to keep in step.
  const dark = settings.theme === 'system' ? darkQuery.matches : settings.theme === 'dark'
  applyTheme(dark ? enviousDark : enviousLight)
  // Without this the engine paints *native* controls for a light page —
  // scrollbars, selects, checkboxes — regardless of what the CSS says, which
  // is why the scrollbars came out white on a dark editor.
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
darkQuery.addEventListener('change', syncTheme)

// --- Settings panel ---------------------------------------------------------

const settingsEl = document.getElementById('settings')!
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function openSettings() {
  el<HTMLInputElement>('setting-preview').checked = settings.showNotePreview
  el<HTMLInputElement>('setting-date').checked = settings.showDateModified
  el<HTMLInputElement>('setting-due').checked = settings.showDueSort
  el<HTMLInputElement>('setting-subfolders').checked = settings.includeSubfolders
  el<HTMLSelectElement>('setting-layout').value = layoutMode
  el<HTMLSelectElement>('setting-theme').value = settings.theme
  settingsEl.classList.remove('hidden')
}

function closeSettings() {
  settingsEl.classList.add('hidden')
}

el('settings-button').onclick = openSettings
el('settings-close').onclick = closeSettings
settingsEl.onclick = (e) => {
  if (e.target === settingsEl) closeSettings() // click the backdrop to dismiss
}

el<HTMLInputElement>('setting-preview').onchange = (e) => {
  settings.showNotePreview = (e.target as HTMLInputElement).checked
  saveSetting('showNotePreview', settings.showNotePreview)
  renderList()
}
el<HTMLInputElement>('setting-date').onchange = (e) => {
  settings.showDateModified = (e.target as HTMLInputElement).checked
  saveSetting('showDateModified', settings.showDateModified)
  renderSortHeader()
  renderList()
}
el<HTMLInputElement>('setting-due').onchange = (e) => {
  settings.showDueSort = (e.target as HTMLInputElement).checked
  saveSetting('showDueSort', settings.showDueSort)
  renderSortHeader()
  renderList()
}
el<HTMLInputElement>('setting-subfolders').onchange = async (e) => {
  settings.includeSubfolders = (e.target as HTMLInputElement).checked
  saveSetting('indexIncludeSubfolders', settings.includeSubfolders)
  await invoke('set_include_subfolders', { include: settings.includeSubfolders })
  await runSearch()
}
el<HTMLSelectElement>('setting-layout').onchange = (e) => {
  layoutMode = (e.target as HTMLSelectElement).value as LayoutMode
  applyLayout()
}
el<HTMLSelectElement>('setting-theme').onchange = (e) => {
  settings.theme = (e.target as HTMLSelectElement).value
  saveSetting('appearanceMode', settings.theme)
  syncTheme()
}
el('settings-open-folder').onclick = () => void invoke('reveal_index')

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsEl.classList.contains('hidden')) closeSettings()
})

async function boot() {
  syncTheme()
  applyLayout()
  renderSortHeader()
  const dir = await invoke<string>('index_directory')
  searchInput.placeholder = `Search ${dir}…`
  el('settings-index-path').textContent = dir
  if (settings.includeSubfolders) {
    await invoke('set_include_subfolders', { include: true })
  }
  await runSearch()
  searchInput.focus()
}

// Exposed for debugging from the webview console. The decoration pass is
// viewport-dependent and link resolution is position-dependent, so
// reproducing either means driving the real view rather than reasoning about
// the regexes in isolation.
;(window as any).__envy = { view, wikiLinkTargetAt }

void boot()
