import { EditorView, keymap, drawSelection, rectangularSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openFolderPicker } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  embedHost,
  envyStyler,
  plainTextField,
  refreshEmbeds,
  searchQueryField,
  setPlainText,
  setSearchQuery,
} from './styler'
import { autoPairing, completionTransforms, emphasisKeymap, pairingEdit } from './input'
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
const titleEl = document.getElementById('note-title') as HTMLInputElement
const dueEl = document.getElementById('note-due')!
const tagsEl = document.getElementById('note-tags')!
const editorEl = document.getElementById('editor')!
const emptyEl = document.getElementById('empty-state')!

let results: NoteDto[] = []
let highlighted = 0
let openNoteId: string | null = null
/// The open note's text as last loaded from or written to disk.
///
/// Saving is guarded against this rather than fired unconditionally. Without
/// the comparison, merely *opening* a note flushes the previous one — an
/// identical rewrite that still stamps a new modified time, so clicking
/// through the list reorders it under a date sort. The Mac guards the same
/// way, in `scheduleSave`: `newValue != note.content`.
let openNoteSavedContent = ''
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
      // Before the default keymap, so Ctrl+B/I reach emphasis rather than the
      // default binding for those chords.
      keymap.of(emphasisKeymap),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      completionTransforms,
      autoPairing,
      searchQueryField,
      plainTextField,
      embedHost.of({
        // Resolved by title on every mount rather than handed a pre-fetched
        // note, so "the source was renamed" and "the source doesn't exist
        // yet" both fall out of the ordinary lookup instead of each needing
        // their own handling.
        resolve: async (title) => {
          const note = await invoke<NoteDto | null>('resolve_title', { title })
          return note && note.content !== null
            ? { id: note.id, title: note.title, content: note.content }
            : null
        },
        save: async (id, content) => {
          await invoke('save_note', { id, content })
          await runSearch()
        },
        currentNoteId: () => openNoteId,
      }),
      envyStyler,
      EditorView.domEventHandlers({
        mousedown: (event, v) => {
          // Ctrl+click follows a link, the Windows spelling of ⌘-click. Envy
          // requires a modifier by default (`requireModifierForLinkClick`) so
          // an ordinary click can still place the cursor inside a link to
          // edit it — the two gestures would otherwise fight.
          // Turning the setting off trades that away for a plain click.
          if (event.button !== 0) return false
          if (settings.requireModifierForLinkClick && !event.ctrlKey) return false
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
        if (u.docChanged && (openNoteId || openTemplatePath)) {
          scheduleSave()
          // Counts track the buffer, not the saved file — they should move as
          // you type, not lag 400ms behind on the save debounce.
          renderStats()
        }
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

// --- Footer: interlinks and counts ------------------------------------------

interface InterlinkRef {
  id: string
  title: string
}
interface SuggestionDto {
  title: string
  /// UTF-16 offsets, so they're usable as JS string indices directly.
  start: number
  end: number
}
interface InterlinksDto {
  links: InterlinkRef[]
  backlinks: InterlinkRef[]
  suggested: SuggestionDto[]
}

const interlinksEl = document.getElementById('interlinks')!
const interlinksToggleEl = document.getElementById('interlinks-toggle') as HTMLButtonElement
const statsEl = document.getElementById('stats')!

let interlinksExpanded = localStorage.getItem('backlinksExpanded') === 'true'
let currentInterlinks: InterlinksDto = { links: [], backlinks: [], suggested: [] }

/// Grapheme clusters, matching Swift's `String.count` — an emoji or an
/// accented character built from combining marks is one character to a reader
/// and should be one here. `Intl.Segmenter` is the only correct way to do that
/// in JS; `.length` counts UTF-16 units and would report 2 for a single emoji.
const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

function countCharacters(text: string): number {
  // Segmenting a very long note on every keystroke is wasted work for a
  // readout nobody reads to the character at that size, so fall back to code
  // points past the point where the difference stops mattering.
  if (!graphemes || text.length > 20000) return [...text].length
  let n = 0
  for (const _ of graphemes.segment(text)) n++
  return n
}

function countWords(text: string): number {
  // Matches Swift's `split { $0.isWhitespace || $0.isNewline }`, which drops
  // empty subsequences — so runs of whitespace collapse rather than counting.
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length
}

function renderStats() {
  if (!openNoteId && !openTemplatePath) {
    statsEl.textContent = ''
    return
  }
  const text = view.state.doc.toString()
  const words = countWords(text)
  const chars = countCharacters(text)
  statsEl.textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}, ${chars.toLocaleString()} character${chars === 1 ? '' : 's'}`
}

function renderInterlinks() {
  const total =
    currentInterlinks.links.length +
    currentInterlinks.backlinks.length +
    currentInterlinks.suggested.length

  if (!openNoteId || total === 0 || !settings.showBacklinks) {
    interlinksToggleEl.classList.add('hidden')
    interlinksEl.classList.add('hidden')
    return
  }

  interlinksToggleEl.classList.remove('hidden')
  // The chevron points where the panel will move on the next click — up to
  // expand (it grows upward), down to collapse.
  interlinksToggleEl.textContent = `${interlinksExpanded ? '▾' : '▴'}  ${total} Interlink${total === 1 ? '' : 's'}`
  interlinksEl.classList.toggle('hidden', !interlinksExpanded)
  if (!interlinksExpanded) return

  const section = (title: string, rows: HTMLElement[]) => {
    const col = document.createElement('div')
    col.className = 'interlink-column'
    const h = document.createElement('h4')
    h.textContent = title
    col.append(h, ...rows)
    return col
  }

  const linkRow = (ref: InterlinkRef) => {
    const a = document.createElement('button')
    a.type = 'button'
    a.className = 'interlink-row'
    a.textContent = ref.title
    a.onclick = () => void openNote(ref.id).then(renderList)
    return a
  }

  const cols: HTMLElement[] = []
  // Only the non-empty sections appear, so a note with just backlinks doesn't
  // show two empty headings beside them.
  if (currentInterlinks.links.length) {
    cols.push(section('Links', currentInterlinks.links.map(linkRow)))
  }
  if (currentInterlinks.backlinks.length) {
    cols.push(section('Backlinks', currentInterlinks.backlinks.map(linkRow)))
  }
  if (currentInterlinks.suggested.length) {
    cols.push(
      section(
        'Suggested',
        currentInterlinks.suggested.map((s) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'interlink-row suggested'
          b.textContent = s.title
          b.title = 'Wrap this mention in [[…]]'
          b.onclick = () => void linkSuggestion(s)
          return b
        }),
      ),
    )
  }
  interlinksEl.replaceChildren(...cols)
}

/// Wraps a suggested mention in `[[…]]` — the only thing that ever changes a
/// note's text from the interlinks panel, and only on this explicit click.
async function linkSuggestion(s: SuggestionDto) {
  const text = view.state.doc.toString()
  // Re-verify before writing: the offsets came from the store's copy, and the
  // buffer may have moved on since. Wrapping the wrong span of someone's note
  // is far worse than doing nothing.
  if (text.slice(s.start, s.end).toLowerCase() !== s.title.toLowerCase()) {
    await refreshInterlinks()
    return
  }
  view.dispatch({
    changes: [
      { from: s.start, insert: '[[' },
      { from: s.end, insert: ']]' },
    ],
  })
  cancelPendingSave()
  await save()
  await refreshInterlinks()
}

async function refreshInterlinks() {
  if (!openNoteId) {
    currentInterlinks = { links: [], backlinks: [], suggested: [] }
    renderInterlinks()
    return
  }
  currentInterlinks = await invoke<InterlinksDto>('interlinks', { id: openNoteId })
  renderInterlinks()
}

interlinksToggleEl.onclick = () => {
  interlinksExpanded = !interlinksExpanded
  saveSetting('backlinksExpanded', interlinksExpanded)
  renderInterlinks()
  view.requestMeasure()
}

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
  const content = view.state.doc.toString()
  // Nothing changed — writing anyway would touch the modified time and
  // reorder the list for no reason.
  if (content === openNoteSavedContent) return

  if (openTemplatePath) {
    try {
      await invoke('save_template', { path: openTemplatePath, content })
      openNoteSavedContent = content
    } catch (e) {
      console.error('template save failed', e)
    }
    return
  }

  if (!openNoteId) return
  try {
    const saved = await invoke<NoteDto>('save_note', {
      id: openNoteId,
      content,
    })
    openNoteSavedContent = content
    applySavedNote(saved)
    // Editing text can add or remove a [[link]], which changes what this note
    // points at and what it merely mentions.
    void refreshInterlinks()
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
  const show = due && settings.showDuePill
  dueEl.textContent = show ? formatDue(due) : ''
  dueEl.className = show ? `envy-due-${dueUrgencyClass(due)}` : ''
}

/// Tags of the open note, shown beside its title. Off by default — the tags
/// are already visible in the text, so this is for people who want them
/// summarised rather than hunted for.
function renderTitleBarTags(tags: string[]) {
  tagsEl.replaceChildren()
  if (!settings.showTagsInTitleBar || tags.length === 0) return
  for (const t of tags) {
    const el = document.createElement('span')
    el.className = 'envy-tag title-tag'
    el.textContent = `#${t}`
    el.title = `Search tag:${t}`
    el.onclick = () => {
      searchInput.value = `tag:${t}`
      void runSearch()
    }
    tagsEl.append(el)
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
  moveFocusToEditorOnEnter: boolSetting('moveFocusToEditorOnEnter', true),
  dateDisplayStyle: localStorage.getItem('dateDisplayStyle') ?? 'smart',
  newNotesStartInInbox: boolSetting('newNotesStartInInbox', false),
  showInboxInMainList: boolSetting('showInboxInMainList', true),
  showTagsInTitleBar: boolSetting('showTagsInTitleBar', false),
  showDuePill: boolSetting('showDuePill', true),
  requireModifierForLinkClick: boolSetting('requireModifierForLinkClick', true),
  showBacklinks: boolSetting('showBacklinks', true),
  hideOnBlur: boolSetting('hideOnFocusLoss', false),
  templateDateFormat: localStorage.getItem('templateDateFormat') ?? 'yyyy-MM-dd',
  trashMaxAgeDays: Number(localStorage.getItem('trashMaxAgeDays') ?? '0'),
}

function saveSetting(key: string, value: string | boolean | number) {
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

/// Three date styles, matching the Mac's picker.
///
/// "Smart" changes unit as things age — a time for today, a weekday within the
/// week, month/day within the year — which is what makes a list of recent
/// notes readable at a glance. The other two are for people who would rather
/// have one consistent shape.
function formatModified(ms: number): string {
  const d = new Date(ms)
  const now = new Date()

  if (settings.dateDisplayStyle === 'absolute') {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayOf = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const days = Math.round((today.getTime() - dayOf.getTime()) / 86400000)

  if (settings.dateDisplayStyle === 'relative') {
    if (days === 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 7) return `${days} days ago`
    if (days < 30) return `${Math.floor(days / 7)} week${days < 14 ? '' : 's'} ago`
    if (days < 365) return `${Math.floor(days / 30)} month${days < 60 ? '' : 's'} ago`
    return `${Math.floor(days / 365)} year${days < 730 ? '' : 's'} ago`
  }

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
  results = applyPinning(sortNotes(results))
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
      if (note.id === trayPinnedId) {
        const pin = document.createElement('span')
        pin.className = 'pin-mark'
        pin.textContent = '📍'
        pin.title = 'Pinned to the tray — clicking the tray icon opens this'
        title.prepend(pin)
      } else if (pinnedIds.has(note.id)) {
        const pin = document.createElement('span')
        pin.className = 'pin-mark'
        pin.textContent = '📌'
        pin.title = 'Pinned to the top of the list'
        title.prepend(pin)
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
      row.oncontextmenu = (e) => {
        e.preventDefault()
        // Right-clicking also moves the highlight, so the menu and the list
        // never disagree about which note is being acted on.
        highlighted = i
        renderList()
        openContextMenu(e.clientX, e.clientY, noteMenuItems(note))
      }
      return row
    }),
  )
}

// --- Zoom and plain-text mode -----------------------------------------------

/// Editor text size, independent of the interface. Notes are what you read for
/// hours; the chrome isn't.
let editorZoom = Number(localStorage.getItem('editorFontZoom') ?? '1')

function applyZoom() {
  const base = Number.parseFloat(enviousDark.fontSize)
  document.documentElement.style.setProperty(
    '--envy-font-size',
    `${(base * editorZoom).toFixed(2)}px`,
  )
  saveSetting('editorFontZoom', editorZoom)
  view.requestMeasure()
}

function setZoom(next: number) {
  // Clamped so a stuck key can't leave the editor unreadably small or absurdly
  // large with no obvious way back short of clearing storage.
  editorZoom = Math.min(2.5, Math.max(0.6, next))
  applyZoom()
}

/// Plain-text mode shows the raw markdown instead of styling it — for when you
/// want to see exactly what's in the file rather than what it means.
let plainTextMode = boolSetting('plainTextMode', false)

function applyPlainTextMode() {
  saveSetting('plainTextMode', plainTextMode)
  // Nothing else to change: the styler simply stops emitting decorations, so
  // the text, cursor and scroll position all stay exactly where they were.
  view.dispatch({ effects: setPlainText.of(plainTextMode) })
}

// --- Inbox ------------------------------------------------------------------
// Fleeting notes wait in Inbox/. The badge is what lets the inbox be a filter
// rather than a mode: the notes stay out of the way, but the number doesn't,
// so a backlog can't quietly accumulate unseen.

const inboxBadgeEl = document.getElementById('inbox-badge') as HTMLButtonElement
const fleetingActionsEl = document.getElementById('fleeting-actions')!

async function refreshInboxBadge() {
  const count = await invoke<number>('inbox_count')
  // Strictly "something is waiting". With the inbox empty there is nowhere to
  // go back *from*, and clearing the query is the ordinary way out of any
  // query — so at zero the control disappears rather than sitting at "0".
  if (count === 0) {
    inboxBadgeEl.classList.add('hidden')
    return
  }
  inboxBadgeEl.classList.remove('hidden')
  const inInbox = inboxFragment() !== null
  // The same control in two states rather than two controls: in the inbox
  // it's the way out, everywhere else it's the way in. One position, one
  // shape, and the button that got you somewhere brings you back.
  inboxBadgeEl.textContent = inInbox ? '‹' : String(count)
  inboxBadgeEl.classList.toggle('leaving', inInbox)
  inboxBadgeEl.title = inInbox
    ? 'Back out of the Inbox'
    : `${count} fleeting note${count === 1 ? '' : 's'} waiting — click to review`
}

inboxBadgeEl.onclick = () => {
  searchInput.value = inboxFragment() !== null ? '' : 'inbox:'
  searchInput.focus()
  void runSearch()
}

/// The next fleeting note waiting, excluding the one being acted on — so
/// working through a backlog is a run of decisions rather than a series of
/// round trips back to the list.
function nextFleetingAfter(id: string): NoteDto | null {
  return results.find((n) => n.isInbox && n.id !== id) ?? null
}

async function moveToNextFleeting(actedOnId: string) {
  const next = nextFleetingAfter(actedOnId)
  await runSearch()
  if (next && results.some((n) => n.id === next.id)) {
    await openNote(next.id)
    highlighted = Math.max(0, results.findIndex((n) => n.id === next.id))
    renderList()
  } else {
    closeEditor()
  }
}

document.getElementById('fleeting-submit')!.onclick = async () => {
  if (!openNoteId) return
  const id = openNoteId
  cancelPendingSave()
  await save()
  await invoke('submit_from_inbox', { id })
  await moveToNextFleeting(id)
}

document.getElementById('fleeting-delete')!.onclick = async () => {
  if (!openNoteId) return
  const id = openNoteId
  cancelPendingSave()
  openNoteId = null
  await invoke('delete_note', { id })
  await moveToNextFleeting(id)
}

// --- Trash ------------------------------------------------------------------
// `trash:` swaps the list over to what's been deleted, the same shape
// `template:` and `inbox:` use. Return never acts here — restore and delete
// stay explicit buttons or a right-click, never a side effect of pressing a
// key while browsing what you threw away.

const trashPreviewEl = document.getElementById('trash-preview')!
const trashTitleEl = document.getElementById('trash-preview-title')!
const trashBodyEl = document.getElementById('trash-preview-body')!

let trashResults: NoteDto[] = []

function showTrashPreview(note: NoteDto | null) {
  if (!note) {
    trashPreviewEl.classList.add('hidden')
    return
  }
  trashTitleEl.textContent = note.title
  trashBodyEl.textContent = note.content ?? ''
  trashPreviewEl.classList.remove('hidden')
  emptyEl.classList.add('hidden')
}

function renderTrashList() {
  listEl.replaceChildren(
    ...trashResults.map((note, i) => {
      const row = document.createElement('div')
      row.className = 'row' + (i === highlighted ? ' highlighted' : '')
      const title = document.createElement('div')
      title.className = 'row-title'
      const icon = document.createElement('span')
      icon.className = 'trash-mark'
      icon.textContent = '🗑'
      title.append(icon, document.createTextNode(note.title))
      const date = document.createElement('span')
      date.className = 'row-date'
      date.textContent = formatModified(note.modifiedMs)
      row.append(title, date)

      row.onclick = () => {
        highlighted = i
        renderTrashList()
        showTrashPreview(note)
      }
      row.oncontextmenu = (e) => {
        e.preventDefault()
        highlighted = i
        renderTrashList()
        showTrashPreview(note)
        openContextMenu(e.clientX, e.clientY, trashMenuItems(note))
      }
      return row
    }),
  )
  showTrashPreview(trashResults[highlighted] ?? null)
}

function trashMenuItems(note: NoteDto): MenuItemSpec[] {
  return [
    { label: 'Restore', run: () => restoreTrashed(note) },
    { label: 'Reveal in Explorer', run: () => invoke('reveal_note', { id: note.id }) },
    { label: 'Delete', destructive: true, run: () => deleteTrashed(note) },
  ]
}

async function restoreTrashed(note: NoteDto) {
  await invoke('restore_from_trash', { id: note.id })
  await runSearch()
}

async function deleteTrashed(note: NoteDto) {
  await invoke('delete_from_trash', { id: note.id })
  await runSearch()
}

document.getElementById('trash-restore')!.onclick = () => {
  const note = trashResults[highlighted]
  if (note) void restoreTrashed(note)
}
document.getElementById('trash-reveal')!.onclick = () => {
  const note = trashResults[highlighted]
  if (note) void invoke('reveal_note', { id: note.id })
}
document.getElementById('trash-delete')!.onclick = () => {
  const note = trashResults[highlighted]
  if (note) void deleteTrashed(note)
}

// --- Templates --------------------------------------------------------------
// A template is a plain .md file in the Index's Templates/ folder — never a
// note, and never in the search results. `template:` swaps the list over to
// showing them, live and editable, the same shape trash: and inbox: use.

interface TemplateDto {
  id: string
  name: string
}

let templateResults: TemplateDto[] = []
/// Set while a template (rather than a note) is open in the editor, so saves
/// route to the template file instead of the store.
let openTemplatePath: string | null = null

function renderTemplateList() {
  listEl.replaceChildren(
    ...templateResults.map((t, i) => {
      const row = document.createElement('div')
      row.className = 'row' + (i === highlighted ? ' highlighted' : '')
      const title = document.createElement('div')
      title.className = 'row-title'
      title.textContent = t.name
      const kind = document.createElement('span')
      kind.className = 'row-date'
      kind.textContent = 'Template'
      row.append(title, kind)
      row.onclick = () => {
        highlighted = i
        void openTemplate(t)
      }
      return row
    }),
  )
}

async function openTemplate(t: TemplateDto) {
  cancelPendingSave()
  await save()
  const content = await invoke<string>('read_template', { path: t.id })
  openNoteId = null
  openTemplatePath = t.id
  openNoteSavedContent = content
  titleEl.value = t.name
  titleEl.disabled = true // renaming templates isn't wired up yet
  renderDueBadge(null)
  emptyEl.classList.add('hidden')
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    effects: editable.reconfigure(EditorView.editable.of(true)),
    selection: { anchor: 0 },
  })
  view.requestMeasure()
  currentInterlinks = { links: [], backlinks: [], suggested: [] }
  renderInterlinks()
  renderStats()
  view.focus()
}

async function openHighlightedTemplate() {
  const t = templateResults[highlighted]
  if (!t) return
  await openTemplate(t)
  renderTemplateList()
}

async function runSearch() {
  // Push the query into the editor so matches light up in the open note.
  view.dispatch({ effects: setSearchQuery.of(searchInput.value) })
  // Before the branches: the badge's count comes from the store and its
  // in/out state from the query, so it has to update whichever list is about
  // to be shown.
  void refreshInboxBadge()

  const template = templateFragment()
  if (template !== null) {
    templateResults = await invoke<TemplateDto[]>('list_templates', { fragment: template })
    results = []
    trashResults = []
    highlighted = 0
    trashPreviewEl.classList.add('hidden')
    renderTemplateList()
    return
  }

  const trash = trashFragment()
  if (trash !== null) {
    trashResults = await invoke<NoteDto[]>('trashed_notes', { fragment: trash })
    results = []
    templateResults = []
    highlighted = 0
    // The editor belongs to the Index, not to the trash — hide it rather than
    // leave the last-opened note sitting behind a trash preview.
    closeEditor()
    renderTrashList()
    return
  }

  trashResults = []
  templateResults = []
  trashPreviewEl.classList.add('hidden')
  results = await invoke<NoteDto[]>('search', { query: searchInput.value })
  // Fleeting notes can be kept out of the way until you go looking for them.
  // Never hidden when the query is already about the inbox, though — asking
  // for "inbox:" and being shown nothing because of a setting elsewhere would
  // be its own bug.
  if (!settings.showInboxInMainList && !searchInput.value.toLowerCase().includes('inbox:')) {
    results = results.filter((n) => !n.isInbox)
  }
  highlighted = 0
  renderList()
}

/// Focus the editor after opening, unless the setting says to stay in the
/// search box — some people arrow through results reading, and being thrown
/// into the text each time fights that.
function focusEditorIfWanted() {
  if (settings.moveFocusToEditorOnEnter) view.focus()
}

async function openNote(id: string) {
  // Flush any pending edit to the note we're leaving before switching.
  cancelPendingSave()
  await save()

  const note = await invoke<NoteDto | null>('read_note', { id })
  if (!note) return
  openNoteId = note.id
  openTemplatePath = null
  openNoteSavedContent = note.content ?? ''
  titleEl.value = note.title
  titleEl.disabled = false
  renderDueBadge(note.due)
  renderTitleBarTags(note.tags)
  // Reviewing a fleeting note is a decision — file it or bin it — so the two
  // actions appear only while looking at one.
  fleetingActionsEl.classList.toggle('hidden', !note.isInbox)
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
  renderStats()
  await refreshInterlinks()
}

async function openHighlighted() {
  const target = results[highlighted]
  if (!target) return
  await openNote(target.id)
  renderList()
}

// --- Context menu -----------------------------------------------------------
// Built by hand rather than using the OS menu, because a webview has no access
// to a native one. The trade is that it must reimplement the parts people
// expect for free: dismissal on click-away, Escape, scroll, and window blur,
// plus flipping when it would open past the window edge.

const contextMenuEl = document.getElementById('context-menu')!

interface MenuItemSpec {
  label: string
  run: () => void | Promise<void>
  destructive?: boolean
}


function closeContextMenu() {
  contextMenuEl.classList.add('hidden')
  contextMenuEl.replaceChildren()
}

function openContextMenu(x: number, y: number, items: MenuItemSpec[]) {
  contextMenuEl.replaceChildren(
    ...items.map((item) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'context-item' + (item.destructive ? ' destructive' : '')
      b.textContent = item.label
      b.onclick = () => {
        closeContextMenu()
        void item.run()
      }
      return b
    }),
  )
  // Placed offscreen-but-measurable first: the size isn't known until the
  // items are in the DOM, and it's needed to decide whether to flip.
  contextMenuEl.classList.remove('hidden')
  contextMenuEl.style.left = '0px'
  contextMenuEl.style.top = '0px'
  const { width, height } = contextMenuEl.getBoundingClientRect()
  const left = x + width > window.innerWidth ? Math.max(0, x - width) : x
  const top = y + height > window.innerHeight ? Math.max(0, y - height) : y
  contextMenuEl.style.left = `${left}px`
  contextMenuEl.style.top = `${top}px`
}

// `capture` so a click that lands on something interactive closes the menu
// before that thing handles it, rather than after.
window.addEventListener('mousedown', (e) => {
  if (!contextMenuEl.contains(e.target as Node)) closeContextMenu()
}, true)
window.addEventListener('blur', closeContextMenu)
window.addEventListener('scroll', closeContextMenu, true)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu()
})
// Suppress the webview's own menu everywhere — this is an app, not a page.
window.addEventListener('contextmenu', (e) => e.preventDefault())

function noteMenuItems(note: NoteDto): MenuItemSpec[] {
  return [
    {
      label: pinnedIds.has(note.id) ? 'Unpin Note' : 'Pin Note',
      run: () => {
        highlighted = results.findIndex((n) => n.id === note.id)
        togglePin()
      },
    },
    {
      label: note.id === trayPinnedId ? 'Unpin from Tray' : 'Pin to Tray',
      run: async () => {
        highlighted = results.findIndex((n) => n.id === note.id)
        await toggleTrayPin()
      },
    },
    {
      label: 'Rename',
      run: async () => {
        await openNote(note.id)
        renderList()
        titleEl.focus()
        titleEl.select()
      },
    },
    { label: 'Show in Explorer', run: () => invoke('reveal_note', { id: note.id }) },
    {
      label: 'Make This Note a Template',
      run: async () => {
        await invoke('convert_to_template', { id: note.id })
        if (openNoteId === note.id) closeEditor()
        await runSearch()
      },
    },
    {
      label: 'Move to Trash',
      destructive: true,
      run: async () => {
        highlighted = results.findIndex((n) => n.id === note.id)
        await deleteHighlighted()
      },
    },
  ]
}

// Settings has no in-window control at all, by design. It lives on Ctrl+, and
// in the tray menu — which on Windows is where a background-capable app puts
// its menu, so that's idiomatic rather than a compromise. Anything app-level
// that needs a home later (About, Markup Help, What's New) belongs in the tray
// menu beside it, not in the window.

// --- Pinning ----------------------------------------------------------------
// A pinned note stays at the top of the list regardless of sort. Membership is
// the app's own state rather than anything written into the file — pinning is
// about how *you* want the list arranged, not about the note's content, and
// writing a marker into someone's prose to record a UI preference would be
// the wrong trade.

const pinnedIds = new Set<string>(
  JSON.parse(localStorage.getItem('pinnedIds') ?? '[]') as string[],
)

function persistPins() {
  localStorage.setItem('pinnedIds', JSON.stringify([...pinnedIds]))
}

/// Pinned notes first, each group keeping the order the sort produced.
function applyPinning(notes: NoteDto[]): NoteDto[] {
  if (pinnedIds.size === 0) return notes
  const pinned = notes.filter((n) => pinnedIds.has(n.id))
  const rest = notes.filter((n) => !pinnedIds.has(n.id))
  return [...pinned, ...rest]
}

/// The one note pinned to the tray, if any. Distinct from list pinning: that
/// arranges the list, this substitutes what a tray click does. Only one note
/// can hold it, so setting it displaces whatever held it before.
let trayPinnedId: string | null = localStorage.getItem('trayPinnedId')

async function toggleTrayPin() {
  const target = results[highlighted]
  if (!target) return
  trayPinnedId = trayPinnedId === target.id ? null : target.id
  if (trayPinnedId) localStorage.setItem('trayPinnedId', trayPinnedId)
  else localStorage.removeItem('trayPinnedId')
  await invoke('set_pinned_note', { id: trayPinnedId })
  renderList()
}

function togglePin() {
  const target = results[highlighted]
  if (!target) return
  if (pinnedIds.has(target.id)) pinnedIds.delete(target.id)
  else pinnedIds.add(target.id)
  persistPins()
  renderList()
  // Keep the highlight on the note that just moved, rather than on whatever
  // row happens to sit at the old index now.
  const moved = results.findIndex((n) => n.id === target.id)
  if (moved >= 0) {
    highlighted = moved
    renderList()
  }
}

// --- Query shapes -----------------------------------------------------------

/// Prefix operators that scope the *whole* box rather than filtering within
/// it. Each shows its own kind of thing in the list.
function prefixFragment(query: string, prefix: string): string | null {
  const trimmed = query.trim()
  return trimmed.toLowerCase().startsWith(prefix)
    ? trimmed.slice(prefix.length)
    : null
}

const templateFragment = () => prefixFragment(searchInput.value, 'template:')
const inboxFragment = () => prefixFragment(searchInput.value, 'inbox:')
const trashFragment = () => prefixFragment(searchInput.value, 'trash:')

/// Whether any word in the query is a search operator.
///
/// This is what stops Return creating a note literally named `tag:xyz`. Every
/// operator counts, not just the prefix ones — the query is a filter, and a
/// filter that matches nothing means "nothing matched", not "make me a note
/// called that".
function containsSearchOperator(query: string): boolean {
  return query
    .trim()
    .split(/\s+/)
    .some((raw) => {
      const w = raw.toLowerCase()
      return (
        /^-?(tag|date|due|link|template|trash|inbox|ai):/.test(w) ||
        w === 'orphan:' ||
        w === 'linked:' ||
        w === 'todo:' ||
        w === '-todo:' ||
        w === '-ai:' ||
        (w.startsWith('-') && w.length > 1)
      )
    })
}

/// Return: open the top match, or create a note from what was typed.
///
/// The exceptions matter as much as the rule:
///
/// - `template:` opens the highlighted template for editing.
/// - `trash:` never acts. Restore and delete are always explicit, never a side
///   effect of pressing Return while browsing.
/// - `inbox:` is the one browse operator where Return *writes*: typing
///   `inbox: call mom` captures it. The operator that scopes the box is the one
///   that routes writing into it, so there's no second syntax to learn. A bare
///   `inbox:`, or an exact match on something already waiting, just opens it.
/// - Any other operator query opens the highlighted note and never creates,
///   since the query is a filter rather than a title.
async function openOrCreate() {
  const raw = searchInput.value
  const query = raw.trim()

  if (templateFragment() !== null) {
    await openHighlightedTemplate()
    return
  }
  if (trashFragment() !== null) return

  const inbox = inboxFragment()
  if (inbox !== null) {
    const title = inbox.trim()
    const existing = results.some((n) => n.title.toLowerCase() === title.toLowerCase())
    if (!title || existing) {
      await openHighlighted()
      focusEditorIfWanted()
      return
    }
    await captureToInbox(title)
    return
  }

  if (containsSearchOperator(query)) {
    await openHighlighted()
    focusEditorIfWanted()
    return
  }

  // An exact title match opens rather than duplicating.
  const exact = results.find((n) => n.title.toLowerCase() === query.toLowerCase())
  if (exact) {
    await openNote(exact.id)
    highlighted = results.findIndex((n) => n.id === exact.id)
    renderList()
    focusEditorIfWanted()
    return
  }
  if (results.length > 0) {
    await openHighlighted()
    focusEditorIfWanted()
    return
  }
  if (!query) return

  // "New notes start in the Inbox" makes filing a deliberate act. Notes made
  // by following a link, or from a template, are unaffected — both are already
  // placed, so routing them through a capture queue asks a question you have
  // already answered.
  const command = settings.newNotesStartInInbox ? 'create_inbox_note' : 'create_note'
  const created = await invoke<NoteDto>(command, { title: query })
  searchInput.value = ''
  await runSearch()
  await openNote(created.id)
  renderList()
  focusEditorIfWanted()
}

async function captureToInbox(title: string) {
  const note = await invoke<NoteDto>('create_inbox_note', { title })
  // Back to a bare "inbox:" — you're still in the box, ready for the next
  // thought, rather than leaving the last capture sitting there looking like
  // a filter.
  searchInput.value = 'inbox:'
  await runSearch()
  await openNote(note.id)
  highlighted = Math.max(0, results.findIndex((n) => n.id === note.id))
  renderList()
  view.focus()
}

searchInput.addEventListener('input', () => void runSearch())

/// Whichever list is on screen — notes, or templates while `template:` is
/// typed. Arrowing has to move through what's actually shown.
function currentListLength(): number {
  if (templateFragment() !== null) return templateResults.length
  if (trashFragment() !== null) return trashResults.length
  return results.length
}
function renderCurrentList() {
  if (templateFragment() !== null) renderTemplateList()
  else if (trashFragment() !== null) renderTrashList()
  else renderList()
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlighted = Math.min(highlighted + 1, currentListLength() - 1)
    renderCurrentList()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlighted = Math.max(highlighted - 1, 0)
    renderCurrentList()
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
  openTemplatePath = null
  openNoteSavedContent = ''
  titleEl.value = ''
  titleEl.disabled = false
  dueEl.textContent = ''
  tagsEl.replaceChildren()
  fleetingActionsEl.classList.add('hidden')
  emptyEl.classList.remove('hidden')
  currentInterlinks = { links: [], backlinks: [], suggested: [] }
  renderInterlinks()
  renderStats()
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: '' },
    effects: editable.reconfigure(EditorView.editable.of(false)),
  })
}

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return
  const key = e.key.toLowerCase()

  // Ctrl+Alt+P pins to the top of the list — the Windows spelling of ⌥⌘P.
  if (e.altKey && !e.shiftKey && key === 'p') {
    e.preventDefault()
    togglePin()
    return
  }

  // Ctrl+Alt+T pins the highlighted note to the tray.
  //
  // Deliberately not Ctrl+Alt+Shift+P, which would be the tidier pairing:
  // that chord is registered as a *global* shortcut for unpinning (matching
  // the Mac's ⌥⌘⇧P), and a global shortcut fires even while Envy is focused.
  // Binding both to one chord would have them fight, pinning and unpinning in
  // the same keystroke.
  if (e.altKey && key === 't') {
    e.preventDefault()
    void toggleTrayPin()
    return
  }

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
  // Zoom the note text — Ctrl +/-/0, the Windows spelling of ⌘+/-/0. Both
  // "=" and "+" so it works without Shift on most layouts.
  if (key === '=' || key === '+') {
    e.preventDefault()
    setZoom(editorZoom + 0.1)
    return
  }
  if (key === '-') {
    e.preventDefault()
    setZoom(editorZoom - 0.1)
    return
  }
  if (key === '0') {
    e.preventDefault()
    setZoom(1)
    return
  }

  // Ctrl+Shift+P toggles plain-text mode — the Mac's ⌘⇧P.
  if (e.shiftKey && key === 'p') {
    e.preventDefault()
    plainTextMode = !plainTextMode
    applyPlainTextMode()
    return
  }

  // Ctrl+Shift+B toggles the interlinks panel — the Mac's ⌘⇧B.
  if (e.shiftKey && key === 'b') {
    e.preventDefault()
    interlinksToggleEl.click()
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
  // The "always current" half of transclusion: a source note edited elsewhere
  // should update where it's embedded, not keep showing what it looked like
  // when the host note was opened.
  refreshEmbeds()
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
      // What's on disk is now what's in the buffer, so a later save has
      // nothing to write until the text actually changes again.
      openNoteSavedContent = fresh.content
    }
  }
})

// Summoning should land in the search box — the point of summoning is to type.
void listen('focus-search', () => {
  searchInput.focus()
  searchInput.select()
})

// The popover's "Open" button, and anything else that wants the app brought
// forward on a particular note.
void listen<string>('open-note', async (e) => {
  await openNote(e.payload)
  highlighted = Math.max(0, results.findIndex((n) => n.id === e.payload))
  renderList()
})

// Tray menu: "New Note" and "Settings…".
void listen('new-note', () => {
  searchInput.focus()
  searchInput.select()
})
void listen('open-settings', () => openSettings())

// The tray pin can be cleared from the popover or the global unpin shortcut,
// so the marker in the list has to follow rather than assume.
void listen('pinned-note-changed', async () => {
  trayPinnedId = await invoke<string | null>('pinned_note_id')
  if (trayPinnedId) localStorage.setItem('trayPinnedId', trayPinnedId)
  else localStorage.removeItem('trayPinnedId')
  renderList()
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

const checkbox = (id: string) => el<HTMLInputElement>(id)
const dropdown = (id: string) => el<HTMLSelectElement>(id)

function openSettings() {
  // Autostart is the one value whose truth lives outside the app — a registry
  // entry other tools can change — so it is read from the system each time
  // rather than cached.
  void invoke<boolean>('autostart_enabled').then((on) => {
    checkbox('setting-autostart').checked = on
  })
  checkbox('setting-preview').checked = settings.showNotePreview
  checkbox('setting-date').checked = settings.showDateModified
  checkbox('setting-due').checked = settings.showDueSort
  checkbox('setting-subfolders').checked = settings.includeSubfolders
  checkbox('setting-focus-editor').checked = settings.moveFocusToEditorOnEnter
  checkbox('setting-inbox-new').checked = settings.newNotesStartInInbox
  checkbox('setting-inbox-in-list').checked = settings.showInboxInMainList
  checkbox('setting-show-tags').checked = settings.showTagsInTitleBar
  checkbox('setting-show-due-pill').checked = settings.showDuePill
  checkbox('setting-require-modifier').checked = settings.requireModifierForLinkClick
  checkbox('setting-show-interlinks').checked = settings.showBacklinks
  checkbox('setting-hide-on-blur').checked = settings.hideOnBlur
  dropdown('setting-date-style').value = settings.dateDisplayStyle
  dropdown('setting-trash-age').value = String(settings.trashMaxAgeDays)
  el<HTMLInputElement>('setting-template-date').value = settings.templateDateFormat
  updateTemplateDatePreview()
  dropdown('setting-layout').value = layoutMode
  dropdown('setting-theme').value = settings.theme
  settingsEl.classList.remove('hidden')
}

/// A live preview, because the token language is the part nobody remembers.
function updateTemplateDatePreview() {
  const pattern = el<HTMLInputElement>('setting-template-date').value
  const now = new Date()
  const map: Record<string, string> = {
    yyyy: String(now.getFullYear()),
    MMMM: now.toLocaleDateString(undefined, { month: 'long' }),
    MM: String(now.getMonth() + 1).padStart(2, '0'),
    dd: String(now.getDate()).padStart(2, '0'),
    EEEE: now.toLocaleDateString(undefined, { weekday: 'long' }),
  }
  // Longest token first, or "MM" would eat the front of "MMMM".
  const rendered = pattern.replace(/yyyy|MMMM|MM|dd|EEEE/g, (t) => map[t] ?? t)
  el('setting-template-date-preview').textContent =
    `Preview: ${rendered}  ·  tokens: yyyy MM dd MMMM EEEE`
}

/// Binds a checkbox to a boolean setting, persisting it and running whatever
/// needs to happen afterwards.
function bindToggle(id: string, key: keyof typeof settings, after?: () => void) {
  checkbox(id).onchange = (e) => {
    const on = (e.target as HTMLInputElement).checked
    ;(settings as Record<string, unknown>)[key] = on
    saveSetting(key, on)
    after?.()
  }
}

function closeSettings() {
  settingsEl.classList.add('hidden')
}

el('settings-close').onclick = closeSettings
settingsEl.onclick = (e) => {
  if (e.target === settingsEl) closeSettings() // click the backdrop to dismiss
}

bindToggle('setting-preview', 'showNotePreview', renderList)
bindToggle('setting-date', 'showDateModified', () => {
  renderSortHeader()
  renderList()
})
bindToggle('setting-due', 'showDueSort', () => {
  renderSortHeader()
  renderList()
})
bindToggle('setting-focus-editor', 'moveFocusToEditorOnEnter')
bindToggle('setting-inbox-new', 'newNotesStartInInbox')
bindToggle('setting-inbox-in-list', 'showInboxInMainList', () => void runSearch())
bindToggle('setting-show-tags', 'showTagsInTitleBar', () => {
  const open = results.find((n) => n.id === openNoteId)
  renderTitleBarTags(open?.tags ?? [])
})
bindToggle('setting-show-due-pill', 'showDuePill', () => {
  const open = results.find((n) => n.id === openNoteId)
  renderDueBadge(open?.due ?? null)
})
bindToggle('setting-require-modifier', 'requireModifierForLinkClick')
bindToggle('setting-show-interlinks', 'showBacklinks', renderInterlinks)
bindToggle('setting-hide-on-blur', 'hideOnBlur')

dropdown('setting-date-style').onchange = (e) => {
  settings.dateDisplayStyle = (e.target as HTMLSelectElement).value
  saveSetting('dateDisplayStyle', settings.dateDisplayStyle)
  renderList()
}

dropdown('setting-trash-age').onchange = (e) => {
  settings.trashMaxAgeDays = Number((e.target as HTMLSelectElement).value)
  saveSetting('trashMaxAgeDays', settings.trashMaxAgeDays)
}

el<HTMLInputElement>('setting-template-date').oninput = () => {
  settings.templateDateFormat = el<HTMLInputElement>('setting-template-date').value
  saveSetting('templateDateFormat', settings.templateDateFormat)
  updateTemplateDatePreview()
  void invoke('set_template_date_format', { pattern: settings.templateDateFormat })
}

el('setting-reveal-templates').onclick = () => void invoke('reveal_folder', { which: 'templates' })
el('setting-reveal-trash').onclick = () => void invoke('reveal_folder', { which: 'trash' })

async function openFolderDialog(): Promise<string | null> {
  const picked = await openFolderPicker({ directory: true, multiple: false })
  return typeof picked === 'string' ? picked : null
}

el('setting-change-index').onclick = async () => {
  const picked = await openFolderDialog()
  if (!picked) return
  await invoke('set_index_directory', {
    path: picked,
    includeSubfolders: settings.includeSubfolders,
  })
  el('settings-index-path').textContent = picked
  closeEditor()
  searchInput.value = ''
  await runSearch()
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

// Confirmed, because this is the one action in the app that destroys notes
// with no way back — everything else routes through the trash first.
el('setting-empty-trash').onclick = async () => {
  const waiting = await invoke<NoteDto[]>('trashed_notes', { fragment: '' })
  if (waiting.length === 0) {
    window.alert('The trash is already empty.')
    return
  }
  const ok = window.confirm(
    `Permanently delete ${waiting.length} note${waiting.length === 1 ? '' : 's'}? This cannot be undone.`,
  )
  if (!ok) return
  await invoke('empty_trash')
  await runSearch()
}

// Autostart is the one setting whose truth lives outside the app — it's a
// registry entry the user (or another tool) can change behind our back — so
// it's read from the system when Settings opens rather than cached here.
el<HTMLInputElement>('setting-autostart').onchange = async (e) => {
  const box = e.target as HTMLInputElement
  try {
    await invoke('set_autostart', { enabled: box.checked })
  } catch (err) {
    console.error('autostart failed', err)
    box.checked = !box.checked
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsEl.classList.contains('hidden')) closeSettings()
})

// Dismiss on click-away, for people who treat Envy as a summoned scratchpad
// rather than a window they keep open. Off by default: losing the window
// because you glanced at a browser is startling if you didn't ask for it.
//
// try/catch rather than .catch(): getCurrentWindow() throws *synchronously*
// when there's no Tauri context, so there is no promise to attach to — and an
// uncaught throw at module scope takes the whole script with it, leaving a
// blank window with nothing in the console to explain it.
try {
  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (!focused && settings.hideOnBlur && settingsEl.classList.contains('hidden')) {
      void getCurrentWindow().hide()
    }
  })
} catch {
  // Running outside Tauri (a plain browser during development).
}

async function boot() {
  syncTheme()
  applyZoom()
  applyPlainTextMode()
  applyLayout()
  renderSortHeader()
  // The backend keeps the tray pin only in memory, so hand it back the value
  // that survived the restart.
  if (trayPinnedId) await invoke('set_pinned_note', { id: trayPinnedId })
  // The placeholder stays "Search or Create Note" — the Index path belongs in
  // Settings, where it can be changed. Repeating it in the box a person looks
  // at all day is noise about something that never varies.
  const dir = await invoke<string>('index_directory')
  el('settings-index-path').textContent = dir
  if (settings.includeSubfolders) {
    await invoke('set_include_subfolders', { include: true })
  }
  await invoke('set_template_date_format', { pattern: settings.templateDateFormat })
  // Swept at launch rather than on a timer: a note app isn't reliably running
  // when a timer would fire, and "cleared next time you opened Envy" is both
  // easier to reason about and impossible to miss.
  if (settings.trashMaxAgeDays > 0) {
    await invoke('sweep_trash', { maxAgeDays: settings.trashMaxAgeDays })
  }
  await runSearch()
  searchInput.focus()
}

// Exposed for debugging from the webview console. The decoration pass is
// viewport-dependent and link resolution is position-dependent, so
// reproducing either means driving the real view rather than reasoning about
// the regexes in isolation.
;(window as any).__envy = {
  view,
  wikiLinkTargetAt,
  // Lets the interlinks panel be exercised without a backend, so its layout
  // can be checked in a plain browser rather than by driving the real app.
  // Positioning and dismissal are layout behaviour, checkable in a plain
  // browser without a backend behind them.
  openContextMenu,
  noteMenuItems,
  // The app's *own* references. A dynamic import of the styler from a console
  // yields a separate module record under Vite, and separate StateField
  // identities with it — so a test importing it directly would find the field
  // "not registered" and prove nothing.
  setSearchQuery,
  searchQueryField,
  pairingEdit,
  previewInterlinks(data: InterlinksDto, expanded = true) {
    currentInterlinks = data
    interlinksExpanded = expanded
    openNoteId = openNoteId ?? 'preview'
    renderInterlinks()
  },
}

void boot()
