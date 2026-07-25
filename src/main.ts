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
  changedRange,
  flashField,
  setFlash,
} from './styler'
import {
  autoPairing,
  completionTransforms,
  emphasisKeymap,
  pairingEdit,
  dueTokenAt,
  toggleDueToken,
} from './input'
import { applyTheme, enviousDark, enviousLight } from './theme'
import { createMiniNoteEditor, type MiniNoteEditor } from './mininote'
import { renderReference, type ReferenceTab } from './reference'
import {
  SHORTCUT_SPECS,
  bindingFor,
  conflicts,
  displayBinding,
  eventToBinding,
  globalBindings,
  isModifierOnly,
  matches as matchesShortcut,
  resetAllBindings,
  setBinding,
  type ShortcutId,
} from './shortcuts'

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
/// The emphasis bindings live in a compartment because they're remappable, and
/// a keymap facet can't be changed after the editor is built.
const emphasisKeys = new Compartment()

function applyEditorKeymap() {
  view.dispatch({
    effects: emphasisKeys.reconfigure(
      keymap.of(emphasisKeymap(bindingFor('bold'), bindingFor('italic'))),
    ),
  })
}

const view = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      history(),
      drawSelection(),
      rectangularSelection(),
      // Before the default keymap, so emphasis wins over the default binding
      // for those chords. In a compartment because the bindings are
      // remappable, and a facet can't be changed after the fact.
      emphasisKeys.of(keymap.of(emphasisKeymap(bindingFor('bold'), bindingFor('italic')))),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      completionTransforms,
      autoPairing,
      searchQueryField,
      plainTextField,
      flashField,
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
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false

          // Alt-click previews a link instead of following it.
          if (event.altKey && settings.linkPreview !== 'off') {
            const target = wikiLinkTargetAt(v, pos)
            if (!target) return false
            event.preventDefault()
            void showLinkPreview(target, event.clientX, event.clientY)
            return true
          }

          // Clicking a due date retires it, or brings it back. Checked before
          // links because the two never overlap, and before the modifier gate
          // because retiring a date is a plain click.
          if (!event.ctrlKey && !event.altKey && toggleDueToken(v, pos)) {
            event.preventDefault()
            return true
          }

          if (settings.requireModifierForLinkClick && !event.ctrlKey) return false
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
  // Fixed to "smart" rather than the user's style, as the Mac does: the labels
  // this pill actually shows are identical across styles, so there is nothing
  // for the setting to change here.
  dueEl.textContent = show ? formatDue(due, 'smart') : ''
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
  linkPreview: localStorage.getItem('linkPreviewTrigger') ?? 'altClick',
  listDensity: localStorage.getItem('listDensity') ?? 'compact',
  interfaceTextSize: Number(localStorage.getItem('interfaceTextSize') ?? '1'),
  fadeFocusHighlight: boolSetting('fadeFocusHighlight', false),
  showInTaskbar: boolSetting('showInTaskbar', true),
  showFooterClock: boolSetting('showFooterClock', false),
  showFooterClockDate: boolSetting('showFooterClockDate', false),
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
  // Name takes the slack; Due and Date sit together over the one value column
  // they both control, since only the field being sorted on is displayed there.
  const sortGroup = document.createElement('div')
  sortGroup.className = 'sort-group'
  const buttons = fields.map(([field, label]) => {
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
  })
  const name = buttons.find((b) => b.dataset.field === 'name')!
  sortGroup.append(...buttons.filter((b) => b !== name))
  listHeaderEl.replaceChildren(name, sortGroup)
}

const shortTime = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const abbrevDate = (d: Date) =>
  d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/// The four date styles, matching the Mac's picker exactly.
///
/// "Smart" names the day only while that's still useful — today and yesterday
/// carry a time, because for a note touched in the last two days *when* is the
/// interesting part; anything older is just a date.
function formatModified(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86400000)

  switch (settings.dateDisplayStyle) {
    case 'relative': {
      if (days === 0) return 'today'
      if (days === 1) return 'yesterday'
      if (days < 7) return `${days} days ago`
      if (days < 30) return `${Math.floor(days / 7)} week${days < 14 ? '' : 's'} ago`
      if (days < 365) return `${Math.floor(days / 30)} month${days < 60 ? '' : 's'} ago`
      return `${Math.floor(days / 365)} year${days < 730 ? '' : 's'} ago`
    }
    case 'dateTime':
      return `${abbrevDate(d)}, ${shortTime(d)}`
    case 'dateOnly':
      return abbrevDate(d)
    default:
      if (days === 0) return `Today, ${shortTime(d)}`
      if (days === 1) return `Yesterday, ${shortTime(d)}`
      return abbrevDate(d)
  }
}

/// A due date's own formatting, distinct from `formatModified` because a due
/// date is a calendar day with no meaningful time — every `@…` token resolves
/// to local midnight — so a clock time beside one is never right.
///
/// Today/Tomorrow/Yesterday and the coming week's day names are the same under
/// every style; only what happens beyond that differs, and only for "relative".
/// This mirrors the Mac's `DateDisplayStyle.formatDueDate`.
function formatDue(iso: string, style: string): string {
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
  if (style === 'relative') return relativeDay(days)
  return abbrevDate(d)
}

/// Named relative wording for a whole number of days either side of today,
/// matching the buckets `formatModified` uses for the past — but a due date can
/// also be in the future, which a modified date never is.
function relativeDay(days: number): string {
  const n = Math.abs(days)
  const label =
    n < 7
      ? `${n} days`
      : n < 30
        ? `${Math.floor(n / 7)} week${n < 14 ? '' : 's'}`
        : n < 365
          ? `${Math.floor(n / 30)} month${n < 60 ? '' : 's'}`
          : `${Math.floor(n / 365)} year${n < 730 ? '' : 's'}`
  return days < 0 ? `${label} ago` : `in ${label}`
}

// --- List virtualization ----------------------------------------------------
// The Mac's list is a `LazyVStack` inside a `ScrollView`: SwiftUI only ever
// materialises the rows actually on screen, so an Index of 5,000 notes costs
// the same to display as one of 50. Building a DOM node per result — which is
// what this did — made every keystroke pay for the whole Index instead, since
// each search re-renders the list.
//
// Same idea reproduced here. One spacer element carries the full scroll height
// so the scrollbar stays honest, and only the rows inside the viewport exist as
// elements, positioned absolutely at their true offsets. The overscan renders a
// few rows past each edge so a fast scroll doesn't flash empty space before the
// next frame lands.

const listSizer = document.createElement('div')
listSizer.id = 'list-sizer'

/// Rows are uniform in height — every field in one is `nowrap`, so nothing
/// reflows onto a second line — but the exact height depends on the row
/// padding, the UI scale and whether previews are switched on. Rather than
/// track all three settings, it's measured from a real rendered row and
/// corrected whenever it turns out to have changed.
let rowHeight = 24
const ROW_OVERSCAN = 6

/// The window currently in the DOM, so scrolling can skip the rebuild whenever
/// the same rows are still the right ones.
let renderedFrom = -1
let renderedTo = -1

/// The list is `overflow: hidden` while the pane is collapsed, and measures
/// zero before first layout. Falling back to a plausible height keeps the
/// first render from producing an empty list that only fills in on scroll.
function listViewport(): number {
  return listEl.clientHeight || 600
}

function renderList() {
  results = applyPinning(sortNotes(results))
  // Whether the trailing value column is reserved at all. There is only one —
  // it shows whichever date the list is sorted by — and "Show date modified"
  // governs it entirely, so with that off the titles get the full width.
  listPaneEl.classList.toggle('has-date', settings.showDateModified)
  // trash: and template: replace the list's children wholesale, so the spacer
  // has to be put back rather than assumed to still be there.
  if (listSizer.parentElement !== listEl) listEl.replaceChildren(listSizer)
  listSizer.style.height = `${results.length * rowHeight}px`
  scrollHighlightIntoView()
  renderRowWindow(true)
}

/// Mirrors the Mac's `.onChange(of: selectedID) { proxy.scrollTo(...) }` —
/// it scrolls when the selection *changes*, not on every re-render, so
/// toggling a setting doesn't yank the list back to the selected row.
///
/// Necessary here in a way it wasn't before: with only the visible rows in the
/// DOM, arrow-keying to an off-screen row would otherwise select something that
/// doesn't exist on screen and never scroll to it.
let lastScrolledId: string | null = null
function scrollHighlightIntoView() {
  const id = results[highlighted]?.id ?? null
  if (id === lastScrolledId) return
  lastScrolledId = id
  if (id === null) return
  const top = highlighted * rowHeight
  const viewport = listViewport()
  if (top < listEl.scrollTop) listEl.scrollTop = top
  else if (top + rowHeight > listEl.scrollTop + viewport) {
    listEl.scrollTop = top + rowHeight - viewport
  }
}

function renderRowWindow(force = false) {
  const viewport = listViewport()
  const from = Math.max(0, Math.floor(listEl.scrollTop / rowHeight) - ROW_OVERSCAN)
  const to = Math.min(
    results.length,
    Math.ceil((listEl.scrollTop + viewport) / rowHeight) + ROW_OVERSCAN,
  )
  if (!force && from === renderedFrom && to === renderedTo) return
  renderedFrom = from
  renderedTo = to

  const rows: HTMLElement[] = []
  for (let i = from; i < to; i++) {
    const row = buildRow(results[i], i)
    row.style.top = `${i * rowHeight}px`
    rows.push(row)
  }
  listSizer.replaceChildren(...rows)

  // Correct the assumed height from a real row. The second pass measures the
  // same height it just set, so this settles after one correction rather than
  // recursing — `force` is dropped so the guard above stops it if it somehow
  // doesn't.
  //
  // Measured fractionally rather than with `offsetHeight`, which rounds to whole
  // pixels. A row that is really 19.4px tall would be recorded as 19, and every
  // row would then be placed 0.4px above where the one before it ends — a hairline
  // gap between rows that widens the further down the list you scroll.
  const measured = rows[0]?.getBoundingClientRect().height
  if (measured && Math.abs(measured - rowHeight) > 0.01) {
    rowHeight = measured
    listSizer.style.height = `${results.length * rowHeight}px`
    renderedFrom = -1
    renderedTo = -1
    renderRowWindow()
  }
}

listEl.addEventListener('scroll', () => renderRowWindow(), { passive: true })

function buildRow(note: NoteDto, i: number): HTMLElement {
      const row = document.createElement('div')
      // The primary selection is marked differently from the rest: it's the
      // one the editor is showing, and losing track of which that is makes a
      // multi-selection feel arbitrary.
      const selected = isSelected(note)
      row.className =
        'row' + (i === highlighted ? ' highlighted' : selected ? ' multi-selected' : '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(selected))

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

      // Title and preview sit together on one line, the preview following the
      // title rather than wrapping under it — the Mac's row is a single HStack.
      const main = document.createElement('div')
      main.className = 'row-main'
      main.append(title)

      // Empty previews are skipped rather than rendered blank, matching the
      // Mac's `showPreview && !note.preview.isEmpty`.
      if (settings.showNotePreview && note.preview) {
        const meta = document.createElement('span')
        meta.className = 'row-meta'
        meta.textContent = note.preview
        main.append(meta)
      }

      row.append(main)

      // One trailing slot, not two. It shows whichever date the list is sorted
      // by — a traditional sortable list shows the column you sorted on, the
      // way Finder's Date Modified column doesn't stick around once you sort by
      // Date Created instead. Only sorting by Due actually changes it; Name
      // falls back to the modified date.
      //
      // showDateModified defaults to true on the Mac and showNotePreview to
      // false, so the default row is title and date. Preview is opt-in, and
      // joins that same line rather than adding a second one.
      if (settings.showDateModified) {
        const date = document.createElement('span')
        date.className = 'row-date'
        if (sortField === 'due') {
          // Left blank when this note has no due date, rather than quietly
          // falling back to the modified date — a sorted column leaves a row's
          // cell empty rather than substituting an unrelated value.
          if (note.due) {
            const suffix = note.dueCount > 1 ? ` +${note.dueCount - 1}` : ''
            date.textContent = formatDue(note.due, settings.dateDisplayStyle) + suffix
            // Urgency colour belongs to a due date, not to a timestamp, so it
            // only applies while the slot is actually showing one.
            date.classList.add(`envy-due-${dueUrgencyClass(note.due)}`)
          }
        } else {
          date.textContent = formatModified(note.modifiedMs)
        }
        row.append(date)
      }

      row.onclick = (e) => {
        if (e.shiftKey) {
          selectRange(i)
          renderList()
          void openHighlighted()
        } else if (e.ctrlKey) {
          toggleMultiSelect(i)
          renderList()
        } else {
          selectSingle(i)
          void openHighlighted()
        }
      }
      row.oncontextmenu = (e) => {
        e.preventDefault()
        const selection = fullSelection()
        // Right-clicking inside an existing multi-selection acts on the whole
        // of it; anywhere else it collapses to that one note first, so the
        // menu and the list never disagree about what's about to happen.
        if (selection.length > 1 && selection.includes(note.id)) {
          openContextMenu(e.clientX, e.clientY, bulkMenuItems(selection.length))
          return
        }
        selectSingle(i)
        renderList()
        openContextMenu(e.clientX, e.clientY, noteMenuItems(note))
      }
      return row
}

/// Briefly highlights text that changed on disk, so an external edit is
/// noticed without having to spot the diff yourself.
///
/// The fade is a CSS transition rather than stepped in JS — the Mac steps the
/// alpha by hand only because text attributes aren't animatable properties.
/// Here they are.
let flashTimer: number | undefined
function flashChangedRange(range: { from: number; to: number } | null) {
  window.clearTimeout(flashTimer)
  if (!range) return
  view.dispatch({ effects: setFlash.of(range) })
  flashTimer = window.setTimeout(() => {
    flashTimer = undefined
    view.dispatch({ effects: setFlash.of(null) })
  }, 900)
}

/// Centres the window on whichever monitor it's currently on.
async function centreWindow() {
  try {
    await getCurrentWindow().center()
  } catch (err) {
    console.error('could not centre the window', err)
  }
}

// --- Link preview ------------------------------------------------------------
// Alt-click a [[link]] to read the note without leaving where you are.
//
// Deliberately a modifier-click rather than hover, following the Mac: a popover
// that appears from a passing hover can sit exactly where a Ctrl-click was
// aimed, and the two gestures collide. Alt has no competing meaning here.

const linkPreviewEl = document.getElementById('link-preview')!
const linkPreviewTitleEl = document.getElementById('link-preview-title')!
const linkPreviewBodyEl = document.getElementById('link-preview-body')!

/// The preview's own editor, torn down each time it closes.
///
/// Not a persistent one reused across previews: it holds a note id and a
/// pending save, and carrying either into a preview of a *different* note is
/// how one note's edit lands in another's file.
let previewEditor: MiniNoteEditor | null = null

function hideLinkPreview() {
  linkPreviewEl.classList.add('hidden')
  const editor = previewEditor
  previewEditor = null
  if (editor) {
    void editor.flush().finally(() => editor.destroy())
  }
}

async function showLinkPreview(target: string, x: number, y: number) {
  hideLinkPreview()
  const note = await invoke<NoteDto | null>('resolve_title', { title: target })
  linkPreviewTitleEl.textContent = note ? note.title : target
  linkPreviewBodyEl.replaceChildren()

  if (note && note.content !== null) {
    // A live editor rather than rendered text: the same code path the embeds
    // use, so a previewed note styles and behaves exactly as it does in the
    // main editor, and can be corrected on the spot without opening it.
    previewEditor = createMiniNoteEditor(
      linkPreviewBodyEl,
      { id: note.id, title: note.title, content: note.content },
      async (id, content) => {
        await invoke('save_note', { id, content })
        await runSearch()
      },
    )
  } else {
    const msg = document.createElement('div')
    msg.className = 'link-preview-message'
    msg.textContent = "This note doesn't exist yet. Ctrl-click the link to create it."
    linkPreviewBodyEl.append(msg)
  }
  linkPreviewEl.classList.remove('hidden')

  // Placed after it has a size, and flipped rather than allowed off-screen.
  const { width, height } = linkPreviewEl.getBoundingClientRect()
  const left = x + width > window.innerWidth ? Math.max(8, x - width) : x
  const top = y + height > window.innerHeight ? Math.max(8, y - height) : y + 18
  linkPreviewEl.style.left = `${left}px`
  linkPreviewEl.style.top = `${top}px`
}

window.addEventListener('mousedown', (e) => {
  if (!linkPreviewEl.contains(e.target as Node)) hideLinkPreview()
}, true)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideLinkPreview()
})

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
  const filed = await invoke<NoteDto>('submit_from_inbox', { id })
  // Filing moves the file out of Inbox/, so the id changes.
  migratePin(id, filed.id)
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
  // Trashed rows always carry a date, whatever the notes list was showing.
  listPaneEl.classList.add('has-date')
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
  const restored = await invoke<NoteDto>('restore_from_trash', { id: note.id })
  migratePin(note.id, restored.id)
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
  // Same as trash: a single trailing label in the value column.
  listPaneEl.classList.add('has-date')
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
  templateActionsEl.classList.remove('hidden')
  view.focus()
}

const templateActionsEl = document.getElementById('template-actions')!

document.getElementById('template-create')!.onclick = async () => {
  if (!openTemplatePath) return
  const name = templateResults.find((t) => t.id === openTemplatePath)?.name ?? ''
  const created = await invoke<NoteDto>('create_note_from_template', {
    path: openTemplatePath,
    title: name,
  })
  // Leaves template-browsing mode: you asked for a note, so show the note.
  searchInput.value = ''
  await runSearch()
  await openNote(created.id)
  selectSingle(Math.max(0, results.findIndex((n) => n.id === created.id)))
  renderList()
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
  void invoke<string[]>('all_tags').then((t) => {
    knownTags = t
  })
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
  templateActionsEl.classList.add('hidden')
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

// --- Multi-select -----------------------------------------------------------
// `highlighted` is the primary selection — the one driving the editor.
// `multiSelected` holds the rest, and `anchorId` is the fixed end of a
// Shift-range so extending it repeatedly grows from where it started rather
// than from wherever the cursor last landed.

const multiSelected = new Set<string>()
let anchorId: string | null = null

function fullSelection(): string[] {
  const primary = results[highlighted]?.id
  const all = new Set(multiSelected)
  if (primary) all.add(primary)
  return [...all]
}

function isSelected(note: NoteDto): boolean {
  return note.id === results[highlighted]?.id || multiSelected.has(note.id)
}

function selectSingle(index: number) {
  highlighted = index
  multiSelected.clear()
  anchorId = results[index]?.id ?? null
}

/// Selects everything between the anchor and `index`, inclusive, in the list's
/// current order. The clicked note becomes the primary, so the editor follows
/// the end you're dragging rather than the end you started from.
function selectRange(index: number) {
  const anchorIndex = results.findIndex((n) => n.id === anchorId)
  if (anchorIndex < 0) {
    selectSingle(index)
    return
  }
  const [lo, hi] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex]
  multiSelected.clear()
  for (let i = lo; i <= hi; i++) {
    const id = results[i]?.id
    if (id) multiSelected.add(id)
  }
  highlighted = index
  multiSelected.delete(results[index]?.id ?? '')
}

/// Toggles one note's membership. Demoting the primary promotes another
/// selected note to take its place, since the primary is what drives the
/// editor and has to stay in step with "is anything selected at all".
function toggleMultiSelect(index: number) {
  const note = results[index]
  if (!note) return
  if (index === highlighted) {
    const next = [...multiSelected][0]
    if (next) {
      multiSelected.delete(next)
      highlighted = results.findIndex((n) => n.id === next)
    }
    return
  }
  if (multiSelected.has(note.id)) multiSelected.delete(note.id)
  else multiSelected.add(note.id)
}

function extendSelection(delta: number) {
  if (results.length === 0) return
  if (!anchorId) anchorId = results[highlighted]?.id ?? null
  selectRange(Math.max(0, Math.min(results.length - 1, highlighted + delta)))
}

async function deleteSelection() {
  const ids = fullSelection()
  if (ids.length === 0) return
  cancelPendingSave()
  if (ids.includes(openNoteId ?? '')) openNoteId = null
  // One call, not a loop: the store treats a single delete as one undo step,
  // so a bulk delete restores as one action.
  await invoke('delete_notes', { ids })
  multiSelected.clear()
  anchorId = null
  if (openNoteId === null) closeEditor()
  await runSearch()
}

function bulkMenuItems(count: number): MenuItemSpec[] {
  return [
    {
      label: `Reveal ${count} Notes in Explorer`,
      run: async () => {
        for (const id of fullSelection()) await invoke('reveal_note', { id })
      },
    },
    { label: `Move ${count} Notes to Trash`, destructive: true, run: deleteSelection },
  ]
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
        // It stops being a note at all, so the pin goes rather than moves.
        migratePin(note.id, null)
        if (openNoteId === note.id) closeEditor()
        await runSearch()
      },
    },
    {
      label: 'Move to Trash',
      destructive: true,
      run: async () => {
        selectSingle(results.findIndex((n) => n.id === note.id))
        await deleteSelection()
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

/// Moves a pin when a note's id changes out from under it.
///
/// A note's id is its file path, so anything that moves the file — a rename,
/// filing a fleeting note, restoring from trash — mints a new id and would
/// silently drop the pin. Losing a pin because you corrected a typo in a title
/// is the kind of small betrayal that stops people trusting the feature.
///
/// Passing `null` as the new id drops the pin instead, for when the note stops
/// being a note at all (becoming a template).
export function migratePin(oldId: string, newId: string | null) {
  if (pinnedIds.delete(oldId)) {
    if (newId) pinnedIds.add(newId)
    persistPins()
  }
  if (trayPinnedId === oldId) {
    trayPinnedId = newId
    if (newId) localStorage.setItem('trayPinnedId', newId)
    else localStorage.removeItem('trayPinnedId')
    void invoke('set_pinned_note', { id: newId })
  }
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

// --- Tag ghost-text ----------------------------------------------------------
// Typing "tag:tec" shows the rest of "technology" ahead of the caret; Tab or
// Right accepts it. Ghost text rather than a dropdown: a list would cover the
// note list, which is the thing you're narrowing.

const searchGhostEl = document.getElementById('search-ghost')!
let knownTags: string[] = []

function ghostCompletion(): string | null {
  const value = searchInput.value
  // Only completes the token being typed, and only at the very end — a
  // completion offered mid-string would insert where the caret isn't.
  if (searchInput.selectionStart !== value.length) return null
  const m = value.match(/(^|\s)-?tag:([A-Za-z0-9_-]*)$/)
  if (!m) return null
  const fragment = m[2].toLowerCase()
  if (!fragment) return null
  const hit = knownTags.find((t) => t.startsWith(fragment) && t !== fragment)
  return hit ? hit.slice(fragment.length) : null
}

function renderGhost() {
  const rest = ghostCompletion()
  searchGhostEl.textContent = rest ? searchInput.value + rest : ''
  searchGhostEl.classList.toggle('hidden', !rest)
}

searchInput.addEventListener('input', () => {
  renderGhost()
  void runSearch()
})
searchInput.addEventListener('blur', () => searchGhostEl.classList.add('hidden'))

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
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const delta = e.key === 'ArrowDown' ? 1 : -1
    // Shift extends the selection; without it, arrowing collapses back to one.
    if (e.shiftKey && templateFragment() === null && trashFragment() === null) {
      extendSelection(delta)
    } else {
      const next = Math.max(0, Math.min(currentListLength() - 1, highlighted + delta))
      if (templateFragment() === null && trashFragment() === null) selectSingle(next)
      else highlighted = next
    }
    renderCurrentList()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    void openOrCreate()
  } else if (e.key === 'Escape') {
    searchInput.value = ''
    void runSearch()
  } else if ((e.key === 'Tab' || e.key === 'ArrowRight') && ghostCompletion()) {
    // Accepts the ghost. Right-arrow as well as Tab because the caret is
    // already at the end, so "move right" and "take the suggestion" are the
    // same gesture there.
    e.preventDefault()
    searchInput.value += ghostCompletion()
    renderGhost()
    void runSearch()
  } else if (e.key === 'Backspace' && e.altKey) {
    // Alt+Backspace clears the whole box — the Mac's ⌥⌫. Faster than
    // selecting and deleting when a long operator query has stopped being
    // useful.
    e.preventDefault()
    searchInput.value = ''
    void runSearch()
  }
})

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
    // The file moved, so its id did too — carry any pin across with it.
    migratePin(openNoteId, renamed.id)
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

// Hovering a truncated title scrolls it, so a long name can be read without
// renaming or resizing. Only when it actually overflows, and never while the
// field is focused — once it's the rename box, the caret drives scrolling and
// two things fighting over scrollLeft is worse than truncation.
let titleScroll: number | undefined
titleEl.addEventListener('mouseenter', () => {
  if (document.activeElement === titleEl) return
  const overflow = titleEl.scrollWidth - titleEl.clientWidth
  if (overflow <= 0) return
  titleEl.classList.add('scrolling')
  const started = performance.now()
  const step = (now: number) => {
    // A slow there-and-back sweep with a pause at each end, so the start and
    // end of the title are both readable rather than flying past.
    const t = ((now - started) / 1000) % 8
    const eased = t < 1 ? 0 : t < 4 ? (t - 1) / 3 : t < 5 ? 1 : (8 - t) / 3
    titleEl.scrollLeft = overflow * Math.min(1, Math.max(0, eased))
    titleScroll = requestAnimationFrame(step)
  }
  titleScroll = requestAnimationFrame(step)
})
titleEl.addEventListener('mouseleave', () => {
  if (titleScroll !== undefined) cancelAnimationFrame(titleScroll)
  titleScroll = undefined
  titleEl.classList.remove('scrolling')
  titleEl.scrollLeft = 0
})

function closeEditor() {
  openNoteId = null
  openTemplatePath = null
  openNoteSavedContent = ''
  titleEl.value = ''
  titleEl.disabled = false
  dueEl.textContent = ''
  tagsEl.replaceChildren()
  fleetingActionsEl.classList.add('hidden')
  templateActionsEl.classList.add('hidden')
  emptyEl.classList.remove('hidden')
  currentInterlinks = { links: [], backlinks: [], suggested: [] }
  renderInterlinks()
  renderStats()
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: '' },
    effects: editable.reconfigure(EditorView.editable.of(false)),
  })
}

// Every app-level binding, dispatched through the shortcut registry rather
// than by testing keys here. A handler that checks `e.key === 'l'` directly is
// a binding nobody can remap and nobody can find.
const SHORTCUT_HANDLERS: Partial<Record<ShortcutId, () => void>> = {
  togglePin,
  pinToTray: () => void toggleTrayPin(),
  centerWindow: () => void centreWindow(),
  openSettings: () => {
    if (settingsEl.classList.contains('hidden')) openSettings()
    else closeSettings()
  },
  // Delete is Ctrl+Backspace rather than the bare Del key Windows convention
  // would suggest: inside the editor Del is forward-delete, and a shortcut
  // that destroys the note you are typing in depending on focus is a bad
  // trade for idiom.
  deleteNote: () => void deleteSelection(),
  restoreDeletedNote: () => void restoreDeleted(),
  zoomIn: () => setZoom(editorZoom + 0.1),
  zoomOut: () => setZoom(editorZoom - 0.1),
  actualSize: () => setZoom(1),
  togglePlainTextMode: () => {
    plainTextMode = !plainTextMode
    applyPlainTextMode()
  },
  toggleInterlinks: () => interlinksToggleEl.click(),
  toggleLayout,
  jumpToSearch: () => {
    searchInput.focus()
    searchInput.select()
  },
  clearSearch: () => {
    searchInput.value = ''
    void runSearch()
  },
  focusNextArea: () => {
    if (document.activeElement === searchInput) view.focus()
    else searchInput.focus()
  },
  focusPreviousArea: () => {
    if (document.activeElement === searchInput) view.focus()
    else searchInput.focus()
  },
}

window.addEventListener('keydown', (e) => {
  for (const [id, run] of Object.entries(SHORTCUT_HANDLERS)) {
    if (!matchesShortcut(id as ShortcutId, e)) continue
    e.preventDefault()
    run?.()
    return
  }
})

window.addEventListener('resize', () => view.requestMeasure())

// The backend rescans and emits; the frontend re-runs its own query rather
// than being handed results, so a reload can't clobber whatever has since been
// typed into the search box.
void listen('index-changed', async () => {
  setLoading(true)
  try {
    await runSearch()
  } finally {
    setLoading(false)
  }
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
      const changed = changedRange(view.state.doc.toString(), fresh.content)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: fresh.content },
        selection: { anchor: Math.min(cursor, fresh.content.length) },
      })
      // What's on disk is now what's in the buffer, so a later save has
      // nothing to write until the text actually changes again.
      openNoteSavedContent = fresh.content
      flashChangedRange(changed)
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

// --- Footer clock and loading indicator --------------------------------------

const clockEl = document.getElementById('footer-clock')!
const loadingEl = document.getElementById('loading-indicator')!

/// Ticks on a timer rather than being computed once — a clock rendered from a
/// value read at startup freezes at whatever time the app happened to open.
let clockTimer: number | undefined
function startClockTick() {
  const tick = () => {
    if (!settings.showFooterClock) {
      clockEl.classList.add('hidden')
      return
    }
    const now = new Date()
    const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    clockEl.textContent = settings.showFooterClockDate
      ? `${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${time}`
      : time
    clockEl.classList.remove('hidden')
  }
  tick()
  window.clearInterval(clockTimer)
  // Every 30s, matching the Mac's own cadence — a minute-resolution clock
  // doesn't need per-second work, but a 60s tick can show a stale minute for
  // almost a whole one.
  clockTimer = window.setInterval(tick, 30_000)
}

/// Shown while a rescan is in flight. It lives in the footer rather than above
/// the list, so it can't shift the list's layout every time it appears — a
/// scan over several thousand notes is common enough (external sync, a bulk
/// import) that a moving list would be a constant distraction.
let loadingDepth = 0
function setLoading(active: boolean) {
  loadingDepth = Math.max(0, loadingDepth + (active ? 1 : -1))
  loadingEl.classList.toggle('hidden', loadingDepth === 0)
}

// --- Reference sheets --------------------------------------------------------
// Markup, Shortcuts, Emoji and About. On the Mac these are separate windows off
// the menu bar; here they share one overlay with tabs, so there is one way in
// and nothing permanently occupying the window.

const referenceEl = document.getElementById('reference')!
const referenceTabsEl = document.getElementById('reference-tabs')!
const referenceContentEl = document.getElementById('reference-content')!

const REFERENCE_TABS: Array<[ReferenceTab, string]> = [
  ['markup', 'Markup'],
  ['shortcuts', 'Shortcuts'],
  ['emoji', 'Emoji'],
  ['whatsnew', "What's New"],
  ['about', 'About'],
]

let appVersion = '0.1.0'

function openReference(tab: ReferenceTab) {
  referenceTabsEl.replaceChildren(
    ...REFERENCE_TABS.map(([id, label]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'reference-tab' + (id === tab ? ' active' : '')
      b.textContent = label
      b.onclick = () => openReference(id)
      return b
    }),
  )
  referenceContentEl.replaceChildren(renderReference(tab, appVersion))
  referenceContentEl.scrollTop = 0
  referenceEl.classList.remove('hidden')
}

function closeReference() {
  referenceEl.classList.add('hidden')
}

document.getElementById('reference-close')!.onclick = closeReference
referenceEl.onclick = (e) => {
  if (e.target === referenceEl) closeReference()
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !referenceEl.classList.contains('hidden')) closeReference()
})

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
  dropdown('setting-link-preview').value = settings.linkPreview
  dropdown('setting-density').value = settings.listDensity
  dropdown('setting-text-size').value = String(settings.interfaceTextSize)
  checkbox('setting-fade-focus').checked = settings.fadeFocusHighlight
  checkbox('setting-taskbar').checked = settings.showInTaskbar
  checkbox('setting-clock').checked = settings.showFooterClock
  checkbox('setting-clock-date').checked = settings.showFooterClockDate
  recording = null
  renderShortcutSettings()
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

/// Row padding per density, matching the Mac's own values.
const DENSITY_PADDING: Record<string, string> = { compact: '1px', cozy: '5px', comfy: '10px' }

/// The chrome scale — the list, the search box, the footer. Deliberately not
/// the note text, which has its own zoom: the two are different jobs, and
/// wanting bigger UI is not the same as wanting bigger prose.
function applyChromeSettings() {
  document.documentElement.style.setProperty(
    '--envy-row-padding',
    DENSITY_PADDING[settings.listDensity] ?? DENSITY_PADDING.compact,
  )
  document.documentElement.style.setProperty(
    '--envy-ui-scale',
    String(settings.interfaceTextSize),
  )
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

dropdown('setting-density').onchange = (e) => {
  settings.listDensity = (e.target as HTMLSelectElement).value
  saveSetting('listDensity', settings.listDensity)
  applyChromeSettings()
}

dropdown('setting-text-size').onchange = (e) => {
  settings.interfaceTextSize = Number((e.target as HTMLSelectElement).value)
  saveSetting('interfaceTextSize', settings.interfaceTextSize)
  applyChromeSettings()
}

bindToggle('setting-fade-focus', 'fadeFocusHighlight', () =>
  document.body.classList.toggle('fade-focus', settings.fadeFocusHighlight),
)
bindToggle('setting-taskbar', 'showInTaskbar', () =>
  void invoke('set_show_in_taskbar', { show: settings.showInTaskbar }),
)
bindToggle('setting-clock', 'showFooterClock', startClockTick)
bindToggle('setting-clock-date', 'showFooterClockDate', startClockTick)

dropdown('setting-link-preview').onchange = (e) => {
  settings.linkPreview = (e.target as HTMLSelectElement).value
  saveSetting('linkPreviewTrigger', settings.linkPreview)
  if (settings.linkPreview === 'off') hideLinkPreview()
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

// --- Shortcut recorder -------------------------------------------------------

/// Pushes the three global bindings to Rust, which re-registers them with the
/// OS. Called on boot too, so defaults and remaps take the same path and can't
/// drift apart.
async function syncGlobalShortcuts() {
  const g = globalBindings()
  const failed = await invoke<string[]>('set_global_shortcuts', {
    summon: g.summonApp,
    showPinned: g.showPinnedNote,
    unpin: g.unpinFromTray,
  })
  if (failed.length > 0) {
    console.warn('these global shortcuts could not be registered:', failed)
  }
  return failed
}

let recording: ShortcutId | null = null

function renderShortcutSettings() {
  const clashes = conflicts()
  const list = el('shortcut-list')
  list.replaceChildren(
    ...SHORTCUT_SPECS.map((spec) => {
      const row = document.createElement('div')
      row.className = 'shortcut-row'
      row.append(el2('span', 'shortcut-label', spec.label))

      const button = document.createElement('button')
      button.type = 'button'
      const binding = bindingFor(spec.id)
      const clashing = clashes.has(binding)
      button.className =
        'shortcut-key' +
        (recording === spec.id ? ' recording' : '') +
        (clashing ? ' clashing' : '')
      button.textContent =
        recording === spec.id ? 'Press keys…' : displayBinding(binding) || 'Unset'
      button.onclick = () => {
        recording = recording === spec.id ? null : spec.id
        renderShortcutSettings()
      }
      row.append(button)
      return row
    }),
  )

  const note = el('shortcut-conflicts')
  note.textContent =
    clashes.size === 0
      ? ''
      : `Conflicting: ${[...clashes.values()]
          .map((ids) => ids.map((i) => SHORTCUT_SPECS.find((s) => s.id === i)?.label).join(' / '))
          .join('; ')} — only one of each pair will fire.`
}

function el2(tag: string, className: string, text: string): HTMLElement {
  const n = document.createElement(tag)
  n.className = className
  n.textContent = text
  return n
}

// Capture phase, and before the app's own shortcut dispatch: while recording,
// every chord belongs to the recorder — otherwise pressing Ctrl+L to bind it
// would jump to the search box instead.
window.addEventListener(
  'keydown',
  (e) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      recording = null
      renderShortcutSettings()
      return
    }
    // Bare modifiers are ignored, or the recorder captures "Ctrl" the instant
    // you reach for a chord.
    if (isModifierOnly(e)) return
    const id = recording
    setBinding(id, eventToBinding(e))
    recording = null
    renderShortcutSettings()
    if (SHORTCUT_SPECS.find((s) => s.id === id)?.global) void syncGlobalShortcuts()
    if (SHORTCUT_SPECS.find((s) => s.id === id)?.editor) applyEditorKeymap()
  },
  true,
)

el('shortcut-reset').onclick = () => {
  resetAllBindings()
  renderShortcutSettings()
  void syncGlobalShortcuts()
  applyEditorKeymap()
}

el('open-markup').onclick = () => openReference('markup')
el('open-shortcuts').onclick = () => openReference('shortcuts')
el('open-emoji').onclick = () => openReference('emoji')
el('open-about').onclick = () => openReference('about')

el('setting-reveal-templates').onclick = () => void invoke('reveal_folder', { which: 'templates' })
el('setting-reveal-trash').onclick = () => void invoke('reveal_folder', { which: 'trash' })

/// Returns null both when the picker is dismissed and when it fails to open.
///
/// The failure is caught rather than left to reject, because these are `async`
/// click handlers: an unhandled rejection there goes nowhere the user can see,
/// so the button simply appears dead. That is exactly how a missing
/// `dialog:allow-open` capability presented — the plugin was registered in
/// Rust, but registering a plugin is not the same as permitting the frontend to
/// call it, and the denial surfaced as a button that did nothing at all.
async function openFolderDialog(): Promise<string | null> {
  try {
    const picked = await openFolderPicker({ directory: true, multiple: false })
    return typeof picked === 'string' ? picked : null
  } catch (err) {
    console.error('could not open the folder picker', err)
    return null
  }
}

el('setting-change-index').onclick = async () => {
  try {
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
  } catch (err) {
    console.error('could not change the Index folder', err)
  }
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
  applyChromeSettings()
  document.body.classList.toggle('fade-focus', settings.fadeFocusHighlight)
  applyZoom()
  applyPlainTextMode()
  startClockTick()
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
  // Registers the global chords with the OS. Nothing is registered in Rust at
  // startup, so this is the only path — defaults and remaps go the same way.
  await syncGlobalShortcuts()
  if (!settings.showInTaskbar) await invoke('set_show_in_taskbar', { show: false })
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
  dueTokenAt,
  toggleDueToken,
  changedRange,
  selectSingle,
  selectRange,
  toggleMultiSelect,
  extendSelection,
  fullSelection,
  ghostCompletion,
  setTagsForTest: (t: string[]) => {
    knownTags = t
  },
  setResultsForTest: (r: NoteDto[]) => {
    results = r
    multiSelected.clear()
    anchorId = null
    highlighted = 0
  },
  // The list is virtualized, so how much work a render actually does depends on
  // the live viewport height and scroll position. Measuring that means driving
  // the real function against the real element, not counting nodes in the
  // abstract.
  renderList,
  listState: () => ({
    total: results.length,
    rendered: listSizer.childElementCount,
    rowHeight,
    scrollHeight: listEl.scrollHeight,
  }),
  previewInterlinks(data: InterlinksDto, expanded = true) {
    currentInterlinks = data
    interlinksExpanded = expanded
    openNoteId = openNoteId ?? 'preview'
    renderInterlinks()
  },
}

void boot()
