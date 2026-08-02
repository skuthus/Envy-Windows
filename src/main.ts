import { EditorView, keymap, drawSelection, rectangularSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openFolderPicker } from '@tauri-apps/plugin-dialog'
import { getVersion } from '@tauri-apps/api/app'
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window'
import {
  embedHost,
  envyStyler,
  existingTitles,
  isGhostLinkForTest,
  plainTextField,
  refreshEmbeds,
  searchQueryField,
  setPlainText,
  setSearchQuery,
  changedRange,
  flashField,
  setFlash,
  restyle,
} from './styler'
import {
  autoPairing,
  completionTransforms,
  emphasisKeymap,
  pairingEdit,
  dueTokenAt,
  toggleDueToken,
} from './input'
import { editorCompletion, completionSources, ghostRemainderForTest } from './completion'
import { listEditing, listContinuation, isListLine, renumberEdits } from './lists'
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

// Nothing in this app should be able to fail silently again.
//
// Three separate features shipped broken for the same reason: a Tauri call was
// denied by a missing capability, the denial arrived as a *rejected promise*
// rather than a thrown error, and the call site discarded it with `void` or an
// un-awaited async handler. A rejected promise nobody is listening to produces
// no console output, no dialog, and no clue — the control simply does nothing,
// which is indistinguishable from a control that was never wired up.
//
// This makes the whole class audible at the one place every one of them
// surfaces, rather than relying on each call site to remember a `.catch()`.
window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandled rejection — something failed silently:', e.reason)
})

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
  /// The folder this note sits in, relative to the Index root, or null at the
  /// root. What the list's folder dot is coloured by.
  subfolder: string | null
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
const folderChipEl = document.getElementById('note-folder')!
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

// The existing note titles, lowercased, for the editor's ghost-link check — an
// O(1) membership test rebuilt only when the titles change. Declared *above*
// the editor because the styler reads it (through the existingTitles facet)
// while building its first decorations during construction below; a `let` down
// with the other known* lists would still be in its temporal dead zone then,
// and the ReferenceError would take the whole styler plugin down with it.
let knownTitlesLower = new Set<string>()

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
      // Enter/Tab/Shift-Tab continue and nest lists (and ordered lists
      // renumber) — Prec.high inside, so this beats the default newline/indent.
      listEditing,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      // Ghost-text completion for [[links]] and #tags, drawing from the same
      // title/tag lists the search box completes from. Read through a closure
      // so it tracks edits without the editor being reconfigured.
      editorCompletion,
      completionSources.of(() => ({ titles: knownTitles, tags: knownTags })),
      // The set the styler checks a [[link]]'s target against to decide whether
      // it's a ghost. A getter, so it reads the live set without reconfiguring.
      existingTitles.of(() => knownTitlesLower),
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

          // In-note jumps happen on a plain click, no modifier — there's
          // nothing else a footnote reference or a heading anchor could mean.
          if (!event.altKey) {
            const footnote = footnoteRefAt(v, pos)
            if (footnote) {
              const range = footnoteDefinitionRange(v.state.doc.toString(), footnote)
              if (range) {
                event.preventDefault()
                jumpToRange(range)
                return true
              }
            }
            const mdLink = markdownLinkAt(v, pos)
            if (mdLink?.url.startsWith('#')) {
              const range = headingRangeForSlug(v.state.doc.toString(), mdLink.url.slice(1))
              if (range) {
                event.preventDefault()
                jumpToRange(range)
                return true
              }
            }
            // An outbound `[text](http…)` link opens externally, but honours the
            // modifier gate the same as a wiki-link so a plain click can still
            // land the caret to edit the URL.
            if (mdLink && /^https?:\/\//i.test(mdLink.url)) {
              if (settings.requireModifierForLinkClick && !event.ctrlKey) return false
              event.preventDefault()
              void invoke('open_external_url', { url: mdLink.url })
              return true
            }
          }

          if (settings.requireModifierForLinkClick && !event.ctrlKey) return false
          const target = wikiLinkTargetAt(v, pos)
          if (!target) return false
          // With plain click-to-follow on, a click inside the link the caret
          // already sits in is an edit, not a navigation — otherwise a note
          // that is only a link (or repositioning within any link you've
          // entered) could never be clicked into. Ctrl still follows,
          // unconditionally. Mirrors the Mac's caretIsInsideWikiLink carve-out.
          if (!event.ctrlKey) {
            const range = wikiLinkRangeAt(v, pos)
            const caret = v.state.selection.main.from
            if (range && caret >= range.from && caret <= range.to) return false
          }
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
    renderVaultLabel()
    return
  }
  const text = view.state.doc.toString()
  const words = countWords(text)
  const chars = countCharacters(text)
  statsEl.textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}, ${chars.toLocaleString()} character${chars === 1 ? '' : 's'}`
  renderVaultLabel()
}

// Whole-vault totals, cached between the backend reads (which only change when
// notes or folders are added or removed) so the footer label can be repainted
// cheaply as the open note's own counts come and go beside it.
const vaultStatsEl = document.getElementById('vault-stats')!
let vaultCounts = { notes: 0, folders: 0 }

/// Paints the vault-totals label from the cached counts. The folder count is
/// shown only with subfolder scanning on — without it folders don't factor into
/// Envy, so a count would just be noise (the Mac's rule). The `·` divider rule
/// appears only when the open note's own counts sit beside it.
function renderVaultLabel() {
  if (!settings.showFooterVaultCounts) {
    vaultStatsEl.classList.add('hidden')
    return
  }
  const { notes, folders } = vaultCounts
  let label = `${notes.toLocaleString()} note${notes === 1 ? '' : 's'}`
  if (settings.includeSubfolders) {
    label += ` · ${folders.toLocaleString()} folder${folders === 1 ? '' : 's'}`
  }
  vaultStatsEl.textContent = label
  vaultStatsEl.classList.remove('hidden')
  vaultStatsEl.classList.toggle('with-divider', statsEl.textContent !== '')
}

/// Re-reads the vault totals from the store, then repaints. Called on each
/// search, since that's when a note or folder could have appeared or gone.
async function refreshVaultCounts() {
  if (!settings.showFooterVaultCounts) {
    renderVaultLabel()
    return
  }
  try {
    vaultCounts = await invoke<{ notes: number; folders: number }>('vault_counts')
  } catch (err) {
    console.error('could not read vault counts', err)
  }
  renderVaultLabel()
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
/// The full `[[…]]` (or `![[…]]`) span at a position, or null — for deciding
/// whether a click landed inside a link the caret already occupies.
function wikiLinkRangeAt(v: EditorView, pos: number): { from: number; to: number } | null {
  const line = v.state.doc.lineAt(pos)
  const re = /!?\[\[([^\[\]]+)\]\]/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) return { from, to }
  }
  return null
}

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

// --- In-note navigation ------------------------------------------------------
// Clicking a footnote reference jumps to its definition, and a `[text](#slug)`
// anchor jumps to that heading — both within the open note, both on a plain
// click, matching the Mac's envy-footnote / envy-heading schemes. A `[text](url)`
// with an http(s) URL opens externally, honouring the modifier gate like any
// other outbound link.

/// The `[text](url)` markdown link at a position, or null. Mirrors the styler's
/// `link` pattern; url is the part in parentheses.
function markdownLinkAt(v: EditorView, pos: number): { url: string; from: number; to: number } | null {
  const line = v.state.doc.lineAt(pos)
  const re = /(?<!!)\[([^\[\]]+)\]\(([^()\s]+)\)/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) return { url: m[2], from, to }
  }
  return null
}

/// The footnote label at a position when it's a *reference* `[^label]`, or null.
/// A definition marker `[^label]:` (colon straight after) is not a reference and
/// isn't clickable — matching the Mac, where only references carry the link.
function footnoteRefAt(v: EditorView, pos: number): string | null {
  const line = v.state.doc.lineAt(pos)
  const re = /\[\^([^\]]+)\]/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) {
      return v.state.doc.sliceString(to, to + 1) === ':' ? null : m[1]
    }
  }
  return null
}

/// A heading's slug, GitHub-style: lowercased, everything but letters, digits,
/// spaces and hyphens dropped, then runs of spaces collapsed to single dashes.
/// Mirrors MarkdownStyler.headingSlug so `[text](#slug)` matches its heading.
function headingSlug(text: string): string {
  const kept = [...text.toLowerCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c) || c === ' ' || c === '-')
    .join('')
  return kept.split(' ').filter((s) => s.length > 0).join('-')
}

/// The `[^label]:` definition marker range for a footnote label, or null.
function footnoteDefinitionRange(doc: string, label: string): { from: number; to: number } | null {
  const re = /^\[\^([^\]]+)\]:[ \t]*/gm
  for (const m of doc.matchAll(re)) {
    if (m[1] === label) return { from: m.index!, to: m.index! + m[0].length }
  }
  return null
}

/// The range of the heading text whose slug matches, or null. Duplicate slugs
/// get `-1`, `-2`, … in document order, GitHub-style, as the Mac does.
function headingRangeForSlug(doc: string, slug: string): { from: number; to: number } | null {
  const re = /^(#{1,6})[ \t]+(.*)$/gm
  const seen = new Map<string, number>()
  for (const m of doc.matchAll(re)) {
    const base = headingSlug(m[2])
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const resolved = count === 0 ? base : `${base}-${count}`
    if (resolved === slug) {
      const from = m.index! + (m[0].length - m[2].length)
      return { from, to: from + m[2].length }
    }
  }
  return null
}

/// Scrolls a range into view and flashes it — the Mac's scrollRangeToVisible +
/// showFindIndicator. The caret is left untouched, so a jump never disturbs
/// where you were typing.
function jumpToRange(range: { from: number; to: number }) {
  view.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: 'center' }) })
  flashChangedRange(range)
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
// --- Link pills --------------------------------------------------------------
// A bare URL renders as a pill showing just its domain. The emoji beside it is
// a preference keyed by the domain — the note holds the plain URL, so every
// link to one site carries the same mark and nothing is written into the file.

/// The quick picks, matching the Mac's — a spread of source types a commonplace
/// book tends to collect.
const DOMAIN_EMOJI_PRESETS = ['📰', '📄', '📚', '📺', '🎥', '🎧', '🐙', '💻', '🛒', '💬', '⭐️', '🌐']

function domainEmojis(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('domainEmojis') ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function setDomainEmoji(domain: string, emoji: string | null) {
  const all = domainEmojis()
  if (emoji) all[domain] = emoji
  else delete all[domain]
  localStorage.setItem('domainEmojis', JSON.stringify(all))
  // The pill is a widget built during styling, so a restyle is what repaints
  // it — there is no element to poke directly, and nothing in the document
  // changed for the plugin to notice on its own.
  view.dispatch({ effects: restyle.of(null) })
}

// Delegated rather than bound inside the widget: the widget is built by the
// styler, which has no business knowing about commands or context menus, and
// is rebuilt on every restyle anyway.
editorEl.addEventListener('click', (e) => {
  const pill = (e.target as HTMLElement).closest('.envy-url-pill') as HTMLElement | null
  if (!pill?.dataset.url) return
  e.preventDefault()
  void invoke('open_external_url', { url: pill.dataset.url }).catch((err) =>
    console.error('could not open the link', err),
  )
})

editorEl.addEventListener('contextmenu', (e) => {
  const pill = (e.target as HTMLElement).closest('.envy-url-pill') as HTMLElement | null
  const domain = pill?.dataset.domain
  if (!domain) return
  e.preventDefault()
  e.stopPropagation()
  const current = domainEmojis()[domain]
  // Bare emoji, as the Mac's menu items are — the domain is already named by
  // the pill that was right-clicked, so repeating it on all twelve rows is
  // noise.
  const items: MenuItemSpec[] = DOMAIN_EMOJI_PRESETS.map((emoji) => ({
    label: emoji,
    run: () => setDomainEmoji(domain, emoji),
  }))
  items.push({ label: '', separator: true })
  items.push({
    label: 'Other…',
    run: async () => {
      // macOS can open the Character Viewer and read the choice back. Windows
      // has no equivalent an app can invoke, so this asks for the character
      // instead — Win+. opens the system emoji panel inside the field, which
      // is the same gesture, just started by the person rather than the app.
      const picked = await textPrompt(`Emoji for ${domain} — press Win+. to pick one`, current ?? '')
      if (picked === null) return
      // One character. The picker can leave a variation selector behind, and
      // an emoji is one glyph however many code units it takes.
      const first = [...picked.trim()][0] ?? null
      setDomainEmoji(domain, first)
    },
  })
  if (current) {
    items.push({
      label: 'Remove Emoji',
      destructive: true,
      run: () => setDomainEmoji(domain, null),
    })
  }
  openContextMenu(e.clientX, e.clientY, items)
})

// --- Tag colours -------------------------------------------------------------
// Like a folder's colour, this is a *preference*, not note content. The `#tag`
// in the file is the truth and stays exactly as portable as before; the tint is
// presentation, the way the theme is. Open the vault in another editor and the
// tag still categorises exactly as it did — only the colour, which was never in
// the file, is absent.
//
// The colour belongs to the tag *name*, so every note carrying it shows the
// same one. That is the line that stops coloured tags becoming hidden per-note
// state attached to a note behind its back.

function tagColors(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('tagColors') ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function setTagColor(tag: string, color: string | null) {
  const all = tagColors()
  if (color) all[tag] = color
  else delete all[tag]
  localStorage.setItem('tagColors', JSON.stringify(all))
  const open = results.find((n) => n.id === openNoteId)
  renderTitleBarTags(open?.tags ?? [])
}

function tagColorMenu(tag: string): MenuItemSpec[] {
  const current = tagColors()[tag]
  const items: MenuItemSpec[] = FOLDER_PRESETS.map(([label, hex]) => ({
    label,
    swatch: hex,
    run: () => setTagColor(tag, hex),
  }))
  if (current) {
    items.push({ label: '', separator: true })
    items.push({
      label: 'Remove Color',
      destructive: true,
      run: () => setTagColor(tag, null),
    })
  }
  return items
}

function renderTitleBarTags(tags: string[]) {
  tagsEl.replaceChildren()
  if (!settings.showTagsInTitleBar || tags.length === 0) return
  const colors = tagColors()
  for (const t of tags) {
    const el = document.createElement('span')
    el.className = 'envy-tag title-tag'
    el.textContent = `#${t}`
    el.title = `Search tag:${t} — right-click to colour it`
    const tint = colors[t]
    if (tint) {
      // A tinted tag paints its own translucent capsule from its colour, so it
      // reads as that colour without needing a second theme entry. An untinted
      // one keeps the theme's ordinary tag background untouched.
      el.style.color = tint
      el.style.background = `color-mix(in srgb, ${tint} 18%, transparent)`
    }
    el.onclick = () => {
      searchInput.value = `tag:${t}`
      void runSearch()
    }
    el.oncontextmenu = (e) => {
      e.preventDefault()
      openContextMenu(e.clientX, e.clientY, tagColorMenu(t))
    }
    tagsEl.append(el)
  }
}

/// The open note's folder as a chip beside its tags. Only for a note that sits
/// in a real subfolder — root and Inbox notes show nothing, so it costs no
/// space when unused. Tinted to the folder's colour (or a neutral outline when
/// it has none). Click pivots to the folder; right-click recolours it — but no
/// Rename here, the same as the Mac's title-bar chip. An outlined capsule, a
/// deliberately different species from the filled tag chips beside it.
function renderTitleBarFolder(subfolder: string | null) {
  folderChipEl.replaceChildren()
  if (!settings.showFolderInTitleBar || !subfolder) {
    folderChipEl.classList.add('hidden')
    return
  }
  folderChipEl.classList.remove('hidden')
  const color = folderColors()[subfolder]
  const chip = document.createElement('span')
  chip.className = 'title-folder-chip'
  chip.title = `In ${subfolder} · click to see this folder's notes`
  const icon = document.createElement('span')
  icon.className = 'title-folder-icon'
  const name = document.createElement('span')
  name.textContent = subfolder
  chip.append(icon, name)
  if (color) {
    chip.style.color = color
    chip.style.borderColor = `color-mix(in srgb, ${color} 40%, transparent)`
  }
  chip.onclick = () => searchByFolder(subfolder)
  chip.oncontextmenu = (e) => {
    e.preventDefault()
    openContextMenu(e.clientX, e.clientY, folderColorMenu(subfolder))
  }
  folderChipEl.append(chip)
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
  // Whole-vault note/folder totals in the footer — on by default, like the Mac.
  showFooterVaultCounts: boolSetting('showFooterVaultCounts', true),
  // The open note's folder as a chip beside its tags — on by default, like the
  // Mac. Only ever shows for a note that actually sits in a subfolder.
  showFolderInTitleBar: boolSetting('showFolderInTitleBar', true),
  // How a note's subfolder shows in the list row: a coloured dot, the folder
  // name as a chip, or nothing. Default 'dot', matching FolderListDisplay.
  folderListDisplay: localStorage.getItem('folderListDisplay') ?? 'dot',
  // Whether that marker sits after the title (the Mac default) or before it.
  // The Inbox mark always leads regardless — it's a different kind of signal.
  folderDotTrailing: boolSetting('folderDotTrailing', true),
  showDuePill: boolSetting('showDuePill', true),
  requireModifierForLinkClick: boolSetting('requireModifierForLinkClick', true),
  showBacklinks: boolSetting('showBacklinks', true),
  // Named for its storage key, not for the DOM event behind it. `bindToggle`
  // writes each setting back under its own property name, so a property called
  // something other than the key it was read from saves to one place and loads
  // from another — which is exactly what happened here: this read
  // "hideOnFocusLoss" and saved "hideOnBlur", so the choice survived until the
  // next launch and no further. The key matches the Mac's own preference.
  hideOnFocusLoss: boolSetting('hideOnFocusLoss', false),
  restoreFocusOnSummon: boolSetting('restoreFocusOnSummon', true),
  linkPreview: localStorage.getItem('linkPreviewTrigger') ?? 'altClick',
  listDensity: localStorage.getItem('listDensity') ?? 'compact',
  interfaceTextSize: Number(localStorage.getItem('interfaceTextSize') ?? '1'),
  fadeFocusHighlight: boolSetting('fadeFocusHighlight', false),
  showInTaskbar: boolSetting('showInTaskbar', true),
  showFooterClock: boolSetting('showFooterClock', false),
  showFooterClockDate: boolSetting('showFooterClockDate', false),
  showFooterClockOnlyWhenFullScreen: boolSetting('showFooterClockOnlyWhenFullScreen', false),
  footerClockDateFormat: localStorage.getItem('footerClockDateFormat') ?? 'short',
  boldFileListText: boolSetting('boldFileListText', false),
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

/// Decoded once per render rather than per row. It is a JSON parse, and the
/// list is the hottest thing in the app — the same reason the Mac caches its
/// folder colours instead of decoding inside the row body.
let folderColorCache: Record<string, string> = {}

function renderList() {
  folderColorCache = folderColors()
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

/// A list row's folder marker, per the folderListDisplay setting: a coloured
/// dot ('dot', only when the folder has a colour), the folder name as a tinted
/// chip ('name', for any subfolder), or nothing ('off'). Clicking it pivots to
/// that folder's notes and right-clicking recolours it — the same gestures the
/// title-bar chip offers. Returns null when there's nothing to draw. The click
/// stops propagating so it never doubles as opening the row's note.
function buildFolderIndicator(subfolder: string): HTMLElement | null {
  const mode = settings.folderListDisplay
  if (mode === 'off') return null
  const color = folderColorCache[subfolder]
  let el: HTMLElement
  if (mode === 'name') {
    el = document.createElement('span')
    el.className = 'folder-name-chip'
    el.textContent = subfolder
    if (color) {
      el.style.color = color
      el.style.background = `color-mix(in srgb, ${color} 15%, transparent)`
    }
  } else {
    // 'dot': the dot alone means "in a coloured folder", so an uncoloured
    // folder shows nothing rather than a blank circle.
    if (!color) return null
    el = document.createElement('span')
    el.className = 'folder-dot row-folder-dot'
    el.style.background = color
  }
  el.title = `In ${subfolder} — click to see this folder's notes`
  el.onclick = (e) => {
    e.stopPropagation()
    searchByFolder(subfolder)
  }
  el.oncontextmenu = (e) => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, folderColorMenu(subfolder))
  }
  return el
}

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
      // The title text lives in its own span so it, and only it, ellipsizes —
      // the folder/inbox/pin markers around it stay whole and centred.
      const titleText = document.createElement('span')
      titleText.className = 'row-title-text'
      titleText.textContent = note.title
      title.append(titleText)

      // A fleeting note is marked with an amber dot, always leading — "unfiled"
      // outranks a folder category, and the two never stack. A filed note in a
      // subfolder instead gets its folder marker, on whichever side the setting
      // chooses (trailing by default; the Inbox mark is unaffected).
      if (note.isInbox) {
        const dot = document.createElement('span')
        dot.className = 'inbox-dot'
        dot.title = 'Fleeting note'
        title.prepend(dot)
      } else if (note.subfolder) {
        const indicator = buildFolderIndicator(note.subfolder)
        if (indicator) {
          indicator.classList.add(settings.folderDotTrailing ? 'marker-trailing' : 'marker-leading')
          if (settings.folderDotTrailing) title.append(indicator)
          else title.prepend(indicator)
        }
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
      // The ⎈ AI-provenance mark is deliberately not shown — the Mac hides its
      // own "until the feature is designed" (NoteRow.swift). The core still
      // parses `aiProvenance`, so the badge can be restored later without
      // touching the scanner.

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
      const nameText = document.createElement('span')
      nameText.className = 'row-title-text'
      nameText.textContent = note.title
      title.append(icon, nameText)
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
      const nameText = document.createElement('span')
      nameText.className = 'row-title-text'
      nameText.textContent = t.name
      title.append(nameText)
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

  const catalog = catalogMode()
  if (catalog !== null) {
    catalogRows = await invoke<CatalogRow[]>(catalog === 'tag' ? 'tag_catalog' : 'folder_catalog')
    results = []
    trashResults = []
    templateResults = []
    highlighted = 0
    trashPreviewEl.classList.add('hidden')
    renderCatalog(catalog)
    return
  }

  trashResults = []
  templateResults = []
  trashPreviewEl.classList.add('hidden')
  void refreshCompletionSources()
  void refreshVaultCounts()
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
  renderTitleBarFolder(note.subfolder ?? null)
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

/// Moves the list selection by one row and shows what it lands on — the way the
/// Mac's list behaves: the editor follows the highlight (as the trash and
/// template previews already do here), and keyboard focus stays put so you can
/// keep arrowing. `extend` grows a Shift-range instead, only in the ordinary
/// note list. Shared by the search box and the window-level handler, so arrows
/// navigate whether or not the search field happens to hold focus — otherwise
/// they fall through to the browser and merely scroll the list.
function arrowNavigate(delta: number, extend: boolean) {
  const catalog = catalogMode()
  const inTemplate = templateFragment() !== null
  const inTrash = trashFragment() !== null
  if (extend && !inTemplate && !inTrash && catalog === null) {
    extendSelection(delta)
    renderList()
    void openHighlighted()
    return
  }
  const next = Math.max(0, Math.min(currentListLength() - 1, highlighted + delta))
  if (next === highlighted && currentListLength() > 0) {
    // Already at the end being pushed against — nothing moves, and re-opening
    // the same note would only fight the editor for no reason.
    return
  }
  if (inTemplate || inTrash) {
    highlighted = next
    renderCurrentList()
  } else if (catalog !== null) {
    highlighted = next
    renderCatalog(catalog)
  } else {
    selectSingle(next)
    renderList()
    void openHighlighted()
  }
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
  /// Omitted for an item that only opens a submenu, and for a separator.
  run?: () => void | Promise<void>
  destructive?: boolean
  /// Turns this item into a submenu. Built lazily, on hover, because the only
  /// one so far lists the Index's folders and walking the disk to fill a menu
  /// nobody opened is work for nothing.
  submenu?: () => MenuItemSpec[] | Promise<MenuItemSpec[]>
  /// A horizontal rule rather than an item. The label is ignored.
  separator?: boolean
  /// A swatch drawn before the label — the colour of the folder an item files
  /// into, so the menu reads the same way the list does.
  swatch?: string | null
}


function closeContextMenu() {
  contextMenuEl.classList.add('hidden')
  contextMenuEl.replaceChildren()
}

/// Builds the rows for one menu level. Shared by the menu and its submenus, so
/// a submenu looks and behaves like the menu it hangs off.
function menuRows(items: MenuItemSpec[], onPick: () => void): HTMLElement[] {
  return items.map((item) => {
    if (item.separator) {
      const hr = document.createElement('div')
      hr.className = 'context-separator'
      return hr
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'context-item' +
      (item.destructive ? ' destructive' : '') +
      (item.submenu ? ' has-submenu' : '')
    if (item.swatch !== undefined) {
      const dot = document.createElement('span')
      dot.className = 'context-swatch'
      // A folder with no colour still gets the slot, so labels line up.
      if (item.swatch) dot.style.background = item.swatch
      else dot.classList.add('empty')
      b.append(dot)
    }
    b.append(document.createTextNode(item.label))

    if (item.submenu) {
      const panel = document.createElement('div')
      panel.className = 'context-submenu hidden'
      b.append(panel)
      let filled = false
      b.onmouseenter = async () => {
        if (!filled) {
          filled = true
          panel.replaceChildren(...menuRows(await item.submenu!(), onPick))
        }
        panel.classList.remove('hidden')
        // Flip to the left when there isn't room on the right.
        const r = panel.getBoundingClientRect()
        panel.classList.toggle('flip', r.right > window.innerWidth)
      }
      b.onmouseleave = () => panel.classList.add('hidden')
      // A parent that only opens a submenu isn't itself clickable.
      if (!item.run) b.onclick = (e) => e.stopPropagation()
    }

    if (item.run) {
      b.onclick = () => {
        onPick()
        void item.run!()
      }
    }
    return b
  })
}

function openContextMenu(x: number, y: number, items: MenuItemSpec[]) {
  contextMenuEl.replaceChildren(...menuRows(items, closeContextMenu))
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

// --- Dialogs -----------------------------------------------------------------
// Stand-ins for window.prompt / window.confirm / window.alert, none of which
// work in Tauri's WebView2 — prompt returns null without ever showing, and
// confirm/alert are suppressed too, so a rename silently did nothing and a
// merge went through with no warning. These drive an in-app modal instead and
// read like the browser APIs they replace: `await textPrompt(...)` resolves to
// the trimmed text or null; `await confirmModal(...)` resolves to a boolean.
const promptEl = document.getElementById('prompt')!
const promptMessageEl = document.getElementById('prompt-message')!
const promptInputEl = document.getElementById('prompt-input') as HTMLInputElement
const promptFormEl = document.getElementById('prompt-panel') as HTMLFormElement
const promptOkEl = document.getElementById('prompt-ok') as HTMLButtonElement
const promptCancelEl = document.getElementById('prompt-cancel') as HTMLButtonElement
// null means cancelled; a string (possibly empty) means confirmed — so the
// confirm variant, which has no text field, still distinguishes OK from Cancel.
let promptResolve: ((value: string | null) => void) | null = null

function closePrompt(value: string | null) {
  if (!promptResolve) return
  const resolve = promptResolve
  promptResolve = null
  promptEl.classList.add('hidden')
  // Focus goes back to the search box — the same place every other overlay
  // hands control back to, so the keyboard never ends up stranded on nothing.
  searchInput.focus()
  resolve(value)
}

/// Opens the modal. `initial === null` is confirm mode: the text field is
/// hidden and OK resolves to '' (confirmed) while Cancel resolves to null.
/// Otherwise it's a prompt and OK resolves to the trimmed field value.
function openDialog(
  message: string,
  initial: string | null,
  okLabel: string,
  cancelLabel: string | null,
): Promise<string | null> {
  // A dialog already open is resolved as cancelled before opening the next, so
  // a stray double-trigger can never leave two fighting over one input.
  if (promptResolve) closePrompt(null)
  const withInput = initial !== null
  promptMessageEl.textContent = message
  promptInputEl.value = initial ?? ''
  promptInputEl.classList.toggle('hidden', !withInput)
  promptOkEl.textContent = okLabel
  // A bare alert has no Cancel — one button that just dismisses it.
  promptCancelEl.classList.toggle('hidden', cancelLabel === null)
  if (cancelLabel) promptCancelEl.textContent = cancelLabel
  promptEl.classList.remove('hidden')
  if (withInput) {
    promptInputEl.focus()
    promptInputEl.select()
  } else {
    promptOkEl.focus()
  }
  return new Promise((resolve) => {
    promptResolve = resolve
  })
}

function textPrompt(message: string, initial = ''): Promise<string | null> {
  return openDialog(message, initial, 'OK', 'Cancel')
}

/// A yes/no confirm. Resolves true only when OK is chosen; Cancel, Escape and a
/// backdrop click all resolve false — the safe default for a destructive step.
function confirmModal(message: string, okLabel = 'OK'): Promise<boolean> {
  return openDialog(message, null, okLabel, 'Cancel').then((v) => v !== null)
}

/// A message with a single dismiss button — the window.alert replacement.
function alertModal(message: string): Promise<void> {
  return openDialog(message, null, 'OK', null).then(() => undefined)
}

promptFormEl.addEventListener('submit', (e) => {
  e.preventDefault()
  // Empty string for confirm/alert (no field); trimmed text for a prompt.
  closePrompt(promptInputEl.classList.contains('hidden') ? '' : promptInputEl.value.trim())
})
promptCancelEl.addEventListener('click', () => closePrompt(null))
// Escape cancels; the capture phase so it beats any list/editor Escape handler
// while the prompt is the thing on screen.
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closePrompt(null)
  }
})
// A click on the backdrop (outside the panel) cancels, like the other overlays.
promptEl.addEventListener('mousedown', (e) => {
  if (e.target === promptEl) closePrompt(null)
})

// --- Folders -----------------------------------------------------------------
// A second axis alongside tags: a note lives in exactly one folder ("which
// pile"), but can carry many tags ("what it's about").
//
// The folder itself is on disk and fully portable — it is just where the file
// sits. The *colour* is a preference keyed by the folder's path relative to the
// Index root, so nothing is ever written into a note, and the key survives the
// Index being moved while still telling apart same-named folders at different
// depths.

/// The palette offered for folders, matching the Mac's presets exactly, so a
/// coloured folder sits in the same family as tags and links.
const FOLDER_PRESETS: Array<[string, string]> = [
  ['Red', '#FF4B39'],
  ['Orange', '#F5A623'],
  ['Yellow', '#F5D423'],
  ['Green', '#30D158'],
  ['Blue', '#5A80FF'],
  ['Purple', '#B46BFF'],
  ['Pink', '#FF6FB0'],
]

function folderColors(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('folderColors') ?? '{}') as Record<string, string>
  } catch {
    // A corrupted preference should cost the colours, not the folders.
    return {}
  }
}

function setFolderColor(folder: string, color: string | null) {
  const all = folderColors()
  if (color) all[folder] = color
  else delete all[folder]
  localStorage.setItem('folderColors', JSON.stringify(all))
  renderList()
  renderFolderColorSettings()
  // The open note's title-bar chip is keyed on the same colour, so recolour it
  // in step rather than waiting for the note to be reopened.
  const open = results.find((n) => n.id === openNoteId)
  renderTitleBarFolder(open?.subfolder ?? null)
}

/// The colour menu for a folder's dot — the same palette as tags, plus a
/// clear. Shown by right-clicking a folder dot in the list or a catalog row.
/// Pivots the search to one folder's notes — the click every folder marker
/// shares (list dot/chip, title-bar chip). The quoted-exact form, since folder
/// names carry spaces far more often than tags; a name containing a quote can't
/// be quoted, so it falls back to the unquoted partial rather than a malformed
/// query. Mirrors the Mac's searchByFolder.
function searchByFolder(folder: string) {
  searchInput.value = folder.includes('"')
    ? `folder:${folder.replace(/"/g, '')}`
    : `folder:"${folder}"`
  void runSearch()
}

function folderColorMenu(folder: string): MenuItemSpec[] {
  const current = folderColors()[folder]
  const items: MenuItemSpec[] = FOLDER_PRESETS.map(([label, hex]) => ({
    label,
    swatch: hex,
    run: () => setFolderColor(folder, hex),
  }))
  if (current) {
    items.push({ label: '', separator: true })
    items.push({
      label: 'Remove Color',
      destructive: true,
      run: () => setFolderColor(folder, null),
    })
  }
  return items
}

// --- Browse catalogs ---------------------------------------------------------
// A bare `tag:` or `folder:` in the search box turns the list into a catalog:
// every tag / folder as a coloured pill or dot with its note count, most-used
// first. Click a row to see its notes (the search pivots to the quoted, exact
// form); right-click to recolour or rename. The operators still filter when
// combined with anything else — the catalog is only the *bare* form.

interface CatalogRow {
  name: string
  count: number
}
type CatalogKind = 'tag' | 'folder'
let catalogRows: CatalogRow[] = []

/// Which catalog the current query asks for, or null. The folder catalog needs
/// subfolders shown — clicking a folder there filters to notes that would
/// otherwise be hidden — so it only offers when they are.
function catalogMode(): CatalogKind | null {
  const q = searchInput.value.trim().toLowerCase()
  if (q === 'tag:') return 'tag'
  if (q === 'folder:' && settings.includeSubfolders) return 'folder'
  return null
}

/// Re-keys the stored colours after a folder rename, so a coloured folder — and
/// everything nested inside it — keeps its colour under the new path rather than
/// silently losing it (the thing a plain Explorer rename does).
function migrateFolderColors(oldPath: string, newPath: string) {
  const all = folderColors()
  let changed = false
  for (const key of Object.keys(all)) {
    if (key === oldPath || key.startsWith(`${oldPath}/`)) {
      const moved = newPath + key.slice(oldPath.length)
      all[moved] = all[key]
      delete all[key]
      changed = true
    }
  }
  if (changed) localStorage.setItem('folderColors', JSON.stringify(all))
}

async function renameTagFlow(oldName: string) {
  const next = (await textPrompt(`Rename #${oldName} to`, oldName))?.trim()
  if (!next || next === oldName) return
  const clean = next.replace(/^#/, '').toLowerCase()
  if (!clean || clean === oldName) return
  // Renaming onto a tag that already exists is a merge — every note carrying
  // the old one comes to carry the survivor. Worth a word first, since it can't
  // be undone in one step.
  const exists = catalogRows.some((r) => r.name === clean)
  if (exists && !(await confirmModal(`#${clean} already exists. Merge #${oldName} into it?`, 'Merge'))) {
    return
  }
  // The colour belongs to the surviving name: keep the target's if it has one,
  // otherwise carry the old tag's colour across.
  const colors = tagColors()
  if (!colors[clean] && colors[oldName]) setTagColor(clean, colors[oldName])
  if (colors[oldName]) setTagColor(oldName, null)
  void invoke('rename_tag', { oldName, newName: clean })
    .then(() => runSearch())
    .catch((err) => console.error('rename tag failed', err))
}

async function renameFolderFlow(oldPath: string) {
  const next = (
    await textPrompt(
      `Rename "${oldPath}" to (add a "/" to file it under another folder)`,
      oldPath,
    )
  )?.trim()
  if (!next || next === oldPath) return
  void invoke<string>('rename_folder', { oldPath, newPath: next })
    .then((newPath) => {
      migrateFolderColors(oldPath, newPath)
      return runSearch()
    })
    .catch((err) => {
      // The command rejects with a human message (reserved / taken / empty).
      void alertModal(typeof err === 'string' ? err : 'Could not rename that folder.')
    })
}

/// Renders the catalog into the list. Rows are keyboard-navigable like the note
/// list; the primary row is highlighted, click pivots, right-click acts.
function renderCatalog(kind: CatalogKind) {
  listPaneEl.classList.remove('has-date')
  const colors = kind === 'tag' ? tagColors() : folderColors()
  listEl.replaceChildren(
    ...catalogRows.map((entry, i) => {
      const row = document.createElement('div')
      row.className = 'row catalog-row' + (i === highlighted ? ' highlighted' : '')
      row.setAttribute('role', 'option')

      const label = document.createElement('span')
      const tint = colors[entry.name]
      if (kind === 'tag') {
        label.className = 'envy-tag catalog-tag'
        label.textContent = `#${entry.name}`
        if (tint) {
          label.style.color = tint
          label.style.background = `color-mix(in srgb, ${tint} 18%, transparent)`
        }
      } else {
        label.className = 'catalog-folder'
        const dot = document.createElement('span')
        dot.className = 'folder-dot'
        // A folder with no colour still gets a hollow marker, so names line up.
        if (tint) dot.style.background = tint
        else dot.classList.add('empty')
        label.append(dot, document.createTextNode(entry.name))
      }

      const count = document.createElement('span')
      count.className = 'catalog-count'
      count.textContent = String(entry.count)
      row.append(label, count)

      const pivot = () => {
        // The quoted form, so clicking a row shows exactly its count — an exact
        // match, never a lookalike.
        searchInput.value = `${kind}:"${entry.name}"`
        void runSearch()
      }
      const menu = () =>
        kind === 'tag'
          ? [
              ...tagColorMenu(entry.name),
              { label: '', separator: true } as MenuItemSpec,
              { label: 'Rename Tag…', run: () => renameTagFlow(entry.name) } as MenuItemSpec,
            ]
          : [
              ...folderColorMenu(entry.name),
              { label: '', separator: true } as MenuItemSpec,
              { label: 'Rename Folder…', run: () => renameFolderFlow(entry.name) } as MenuItemSpec,
            ]

      row.onclick = () => {
        highlighted = i
        pivot()
      }
      row.oncontextmenu = (e) => {
        e.preventDefault()
        highlighted = i
        renderCatalog(kind)
        openContextMenu(e.clientX, e.clientY, menu())
      }
      return row
    }),
  )
}

/// Settings → Folder Colors: one row per folder, with the palette and a way to
/// clear it. Rebuilt on open rather than kept in step, since folders change from
/// outside Envy as readily as from within.
async function renderFolderColorSettings() {
  const list = document.getElementById('folder-colors-list')!
  const empty = document.getElementById('folder-colors-empty')!
  if (!settings.includeSubfolders) {
    list.replaceChildren()
    empty.classList.remove('hidden')
    return
  }
  let folders: string[] = []
  try {
    folders = await invoke<string[]>('list_subfolders')
  } catch (err) {
    console.error('could not list folders', err)
  }
  empty.classList.toggle('hidden', folders.length > 0)
  if (!folders.length) {
    empty.textContent = 'No subfolders yet. Right-click a note → Move to → New Folder…'
    list.replaceChildren()
    return
  }

  const colors = folderColors()
  list.replaceChildren(
    ...folders.map((folder) => {
      const row = document.createElement('div')
      row.className = 'folder-color-row'
      const name = document.createElement('span')
      name.className = 'folder-color-name'
      name.textContent = folder
      row.append(name)

      for (const [label, hex] of FOLDER_PRESETS) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'folder-swatch' + (colors[folder] === hex ? ' active' : '')
        b.style.background = hex
        b.title = label
        b.onclick = () => setFolderColor(folder, hex)
        row.append(b)
      }
      const clear = document.createElement('button')
      clear.type = 'button'
      clear.className = 'folder-swatch none' + (colors[folder] ? '' : ' active')
      clear.title = 'No colour'
      clear.onclick = () => setFolderColor(folder, null)
      row.append(clear)
      return row
    }),
  )
}

/// The "Move to" submenu: the Index root, every folder, and a way to make one.
async function moveToItems(note: NoteDto): Promise<MenuItemSpec[]> {
  let folders: string[] = []
  try {
    folders = await invoke<string[]>('list_subfolders')
  } catch (err) {
    console.error('could not list folders', err)
  }
  const colors = folderColors()
  const move = (to: string | null) => async () => {
    try {
      await invoke<NoteDto>('move_note_to_subfolder', { id: note.id, subfolder: to })
    } catch (err) {
      console.error('could not move the note', err)
      return
    }
    await runSearch()
  }

  const items: MenuItemSpec[] = [{ label: 'The Index', swatch: null, run: move(null) }]
  if (folders.length) items.push({ label: '', separator: true })
  for (const f of folders) {
    // The folder a note is already in is shown but does nothing — moving it
    // there is a no-op anyway, and hiding it makes the list look wrong.
    items.push({ label: f, swatch: colors[f] ?? null, run: move(f) })
  }
  items.push({ label: '', separator: true })
  items.push({
    label: 'New Folder…',
    run: async () => {
      const name = await textPrompt('New folder name')
      if (!name?.trim()) return
      // The move creates the folder on demand, so there is nothing to make
      // first — this is a move to a name that does not exist yet.
      await move(name.trim())()
    },
  })
  return items
}

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
      label: 'Pop Out',
      run: () => void invoke('pop_out_note', { id: note.id, title: note.title }),
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
    // Only when subfolders are actually listed. Filing a note into a folder
    // Envy then hides from the list would look like deleting it.
    ...(settings.includeSubfolders
      ? [{ label: 'Move to', submenu: () => moveToItems(note) } as MenuItemSpec]
      : []),
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
        /^-?(tag|date|stale|due|link|interlink|folder|title|img|embed|template|trash|inbox|ai):/.test(
          w,
        ) ||
        w === 'orphan:' ||
        w === 'linked:' ||
        w === 'ghost:' ||
        w === '-ghost:' ||
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
/// Parses the `Folder/Title` quick-create form. Splits on the *last* slash; the
/// part before must case-insensitively match an existing subfolder (nested
/// ones included), the part after is the title. Returns null — falling through
/// to an ordinary search/create — when subfolders are off, there's no slash, or
/// the folder isn't one that exists. It never invents a folder. Mirrors the
/// Mac's folderTargetedCreation.
function folderTargetedCreation(raw: string): { folder: string; title: string } | null {
  if (!settings.includeSubfolders) return null
  const slash = raw.lastIndexOf('/')
  if (slash === -1) return null
  const folderPart = raw.slice(0, slash).trim()
  const titlePart = raw.slice(slash + 1).trim()
  if (!folderPart || !titlePart) return null
  const match = knownFolders.find((f) => f.toLowerCase() === folderPart.toLowerCase())
  return match ? { folder: match, title: titlePart } : null
}

async function openOrCreate() {
  const raw = searchInput.value
  const query = raw.trim()

  if (templateFragment() !== null) {
    await openHighlightedTemplate()
    return
  }
  if (trashFragment() !== null) return

  const catalog = catalogMode()
  if (catalog !== null) {
    // Enter (or click) on a row pivots the search to that tag/folder, exact.
    const row = catalogRows[highlighted]
    if (row) {
      searchInput.value = `${catalog}:"${row.name}"`
      await runSearch()
    }
    return
  }

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

  // "Work/Retro notes" files a new "Retro notes" inside the Work folder — the
  // slash is a folder picker, and it takes priority over opening a partial
  // match, since typing it is a deliberate "make this here". Only fires when
  // the part before the last slash names a real subfolder, so an ordinary
  // search that happens to contain a slash falls straight through.
  const targeted = folderTargetedCreation(query)
  if (targeted) {
    const created = await invoke<NoteDto>('create_note_in_subfolder', {
      title: targeted.title,
      subfolder: targeted.folder,
    })
    searchInput.value = ''
    await runSearch()
    await openNote(created.id)
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
let knownFolders: string[] = []
let knownTitles: string[] = []

function updateKnownTitles(titles: string[]) {
  knownTitles = titles
  knownTitlesLower = new Set(titles.map((t) => t.toLowerCase()))
  // Nothing in the open note's text changed, so nudge the styler to repaint —
  // otherwise a link stays a ghost after its target is created (or keeps its
  // resolved styling after the target is deleted) until the next keystroke.
  view.dispatch({ effects: restyle.of(null) })
}

/// Which operators complete their argument as you type, and where each draws
/// its suggestions from — matching the Mac's 1.8.4 autofill. `tag:`/`folder:`
/// complete from your real lists; `link:`/`interlink:`/`title:` complete note
/// titles by recency.
///
/// The `-` polarity of each completes too: excluding a folder or tag you have
/// wants the same help as including it.
interface CompletionSpec {
  /// Case-sensitivity of the source. Tags and folders are matched lowercased
  /// (that's how the operators match); titles keep their case so the ghost
  /// reads as the real title.
  source: () => string[]
  lower: boolean
}

const COMPLETION_OPERATORS: Record<string, CompletionSpec> = {
  'tag:': { source: () => knownTags, lower: true },
  'folder:': { source: () => knownFolders, lower: true },
  'link:': { source: () => knownTitles, lower: false },
  'interlink:': { source: () => knownTitles, lower: false },
  'title:': { source: () => knownTitles, lower: false },
}

/// Refreshes the autofill sources. Folders and titles change as notes are
/// edited or moved, and an in-app move is suppressed from the watcher, so this
/// runs on each search rather than only on an external change — all three are
/// cheap (a tag/title projection, a shallow dir walk).
async function refreshCompletionSources() {
  try {
    const [tags, folders, titles] = await Promise.all([
      invoke<string[]>('all_tags'),
      invoke<string[]>('list_subfolders'),
      invoke<string[]>('all_titles'),
    ])
    knownTags = tags
    knownFolders = folders
    // Routes through the setter so the ghost-link title set and a restyle come
    // along with the new titles.
    updateKnownTitles(titles)
  } catch (err) {
    console.error('could not refresh autofill sources', err)
  }
}

/// The completion (the part after what's typed) for the operator argument being
/// typed at the very end of the box, or null.
///
/// Only the token at the caret, and only when the caret is at the end — a ghost
/// offered mid-string would insert where the caret isn't. The whole argument is
/// matched, spaces included, so `link:Rust Gu` completes a multi-word title;
/// the accept step re-quotes anything with a space.
function ghostCompletion(): string | null {
  const value = searchInput.value
  if (searchInput.selectionStart !== value.length) return null
  for (const [op, spec] of Object.entries(COMPLETION_OPERATORS)) {
    // The argument runs from the operator to the end of the box. Preceded by
    // start-or-space, and an optional `-`, and an optional opening quote.
    const re = new RegExp(`(^|\\s)-?${op}"?(.*)$`)
    const m = value.match(re)
    if (!m) continue
    const fragment = m[2]
    if (!fragment) return null
    const needle = spec.lower ? fragment.toLowerCase() : fragment
    const pool = spec.source()
    const hit = pool.find((candidate) => {
      const c = spec.lower ? candidate.toLowerCase() : candidate
      return c.startsWith(needle) && c !== needle
    })
    return hit ? hit.slice(fragment.length) : null
  }
  return null
}

function renderGhost() {
  const rest = ghostCompletion()
  searchGhostEl.textContent = rest ? searchInput.value + rest : ''
  searchGhostEl.classList.toggle('hidden', !rest)
}

/// The box's value with the current ghost accepted, quoting the argument if the
/// completed value contains a space.
///
/// The quote isn't cosmetic: an unquoted space would tokenize `folder:Client
/// Work` into two terms. It also flips the argument to the operators' *exact*
/// match, which is the right default for a name you picked whole from a list —
/// clicking a real folder should mean that folder, not a substring of it.
function acceptCompletion(): string {
  const rest = ghostCompletion()
  if (rest === null) return searchInput.value
  const completed = searchInput.value + rest
  const m = completed.match(/^(.*?(?:^|\s)-?(?:tag|folder|link|interlink|title):)"?(.*)$/)
  if (!m || !m[2].includes(' ')) return completed
  return `${m[1]}"${m[2]}"`
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
  if (catalogMode() !== null) return catalogRows.length
  return results.length
}
function renderCurrentList() {
  const catalog = catalogMode()
  if (templateFragment() !== null) renderTemplateList()
  else if (trashFragment() !== null) renderTrashList()
  else if (catalog !== null) renderCatalog(catalog)
  else renderList()
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    arrowNavigate(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
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
    searchInput.value = acceptCompletion()
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

// Arrow-key list navigation when the search box does *not* hold focus. After
// clicking a note or a catalog row, focus sits on the body, and without this
// the arrows would fall through to the browser and merely scroll the list
// instead of moving the selection — the thing the Mac's list does with them.
// The editor keeps its own arrows for the cursor, and so do the search and
// title fields and any open overlay, so this only steps in when the list is
// what you're looking at.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  if (e.defaultPrevented) return
  if (view.hasFocus) return
  const active = document.activeElement as HTMLElement | null
  if (active) {
    const tag = active.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
  }
  // Don't move the list behind a dialog that has taken over the screen.
  if (
    !settingsEl.classList.contains('hidden') ||
    !promptEl.classList.contains('hidden') ||
    !referenceEl.classList.contains('hidden')
  ) {
    return
  }
  e.preventDefault()
  arrowNavigate(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
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
  renderTitleBarFolder(null)
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
  // The Mac's newFromTemplateRequested does exactly this — puts "template:" in
  // the search field and focuses it. The template list is already what that
  // query shows, so the shortcut is a way into it rather than a separate mode.
  newFromTemplate: () => {
    searchInput.value = 'template:'
    searchInput.focus()
    void runSearch()
  },
  extractToNote: () => void extractSelectionToNote(),
  focusNextArea: () => {
    if (document.activeElement === searchInput) view.focus()
    else searchInput.focus()
  },
  focusPreviousArea: () => {
    if (document.activeElement === searchInput) view.focus()
    else searchInput.focus()
  },
}

/// Splits the selection off into a note of its own, leaving a `[[link]]` behind.
///
/// The replacement goes through a normal editor transaction rather than being
/// written around it, so the split lands on the undo stack as one step and
/// triggers the ordinary save and restyle — the same reason the Mac routes it
/// through `shouldChangeText`/`didChangeText` instead of mutating storage
/// directly.
///
/// No naming prompt: the title comes from the selection's first line. This is
/// meant to keep writing flowing, and a dialog in the middle of it would do the
/// opposite — renaming afterwards is one keystroke away if the guess is wrong.
async function extractSelectionToNote() {
  const { from, to } = view.state.selection.main
  if (from === to) return
  const selected = view.state.sliceDoc(from, to)
  if (!selected.trim()) return

  let created: NoteDto
  try {
    created = await invoke<NoteDto>('extract_to_note', {
      selection: selected,
      inInbox: settings.newNotesStartInInbox,
    })
  } catch (err) {
    console.error('could not extract the selection', err)
    return
  }

  const link = `[[${created.title}]]`
  view.dispatch({
    changes: { from, to, insert: link },
    // The cursor lands after the link, where writing would naturally carry on,
    // rather than leaving the whole link selected.
    selection: { anchor: from + link.length },
  })
  view.focus()
  await runSearch()
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
// "Keep focus where it was when summoned" — on by default, as on the Mac.
//
// The window is hidden rather than torn down between summons, so whatever had
// focus still has it when it comes back; the setting only decides whether to
// override that. Turning it off sends focus to the search box, which is what
// this did unconditionally before the setting existed.
void listen('summoned', () => {
  if (settings.restoreFocusOnSummon) return
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

/// The four clock date formats, matching the Mac's `ClockDateFormat` exactly —
/// the same four cases, in the same order, producing the same shapes.
function formatClockDate(d: Date): string {
  switch (settings.footerClockDateFormat) {
    case 'medium':
      return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    case 'full':
      return d.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    case 'numeric':
      return d.toLocaleDateString(undefined, {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
      })
    default:
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
}

/// Whether the window currently fills the screen.
///
/// macOS has a real full-screen mode a window is either in or not. Windows has
/// both true full screen and maximised, and maximised is what someone here
/// means by it, so either counts.
///
/// Asked of the window rather than inferred by comparing `outerWidth` against
/// `screen.width`. That comparison is not just approximate, it fails *unsafely*:
/// where those values are unavailable they are all zero, zero matches zero, and
/// it concludes the window is full screen — so the setting silently stops
/// hiding anything. Both calls are read-only and already in `core:window:default`.
async function isFullScreen(): Promise<boolean> {
  try {
    const w = getCurrentWindow()
    return (await w.isFullscreen()) || (await w.isMaximized())
  } catch {
    // Outside Tauri. Reporting "not full screen" keeps the clock visible rather
    // than hiding it for a reason that cannot be checked.
    return false
  }
}

/// Ticks on a timer rather than being computed once — a clock rendered from a
/// value read at startup freezes at whatever time the app happened to open.
let clockTimer: number | undefined
function startClockTick() {
  const tick = async () => {
    if (!settings.showFooterClock) {
      clockEl.classList.add('hidden')
      return
    }
    // "Only in full screen" is for people who want the clock exactly when the
    // window is covering the one in the system tray, and not otherwise.
    if (settings.showFooterClockOnlyWhenFullScreen && !(await isFullScreen())) {
      clockEl.classList.add('hidden')
      return
    }
    const now = new Date()
    const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    clockEl.textContent = settings.showFooterClockDate
      ? `${formatClockDate(now)} · ${time}`
      : time
    clockEl.classList.remove('hidden')
  }
  void tick()
  window.clearInterval(clockTimer)
  // Every 30s, matching the Mac's own cadence — a minute-resolution clock
  // doesn't need per-second work, but a 60s tick can show a stale minute for
  // almost a whole one.
  clockTimer = window.setInterval(() => void tick(), 30_000)
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

/// Asked of the app itself rather than written down here.
///
/// It used to be the literal "0.1.0", which nothing ever updated — so About
/// went on claiming 0.1.0 while the installed build was 0.1.1, and would have
/// drifted further with every release. A version string that has to be edited
/// by hand in a second place is a version string that will eventually lie, and
/// About is the one screen whose entire job is to answer this accurately.
///
/// "unknown" only shows outside Tauri, where there is no app to ask.
/// Wrapped, not just `.catch()`ed, for the same reason the focus handler below
/// is: outside Tauri these helpers can throw synchronously rather than reject,
/// and an uncaught throw at module scope takes the rest of the script with it.
let appVersion = 'unknown'
try {
  void getVersion()
    .then((v) => {
      appVersion = v
      showWhatsNewIfUpdated(v)
    })
    .catch((err) => console.error('could not read the app version', err))
} catch (err) {
  console.error('could not read the app version', err)
}

/// Opens What's New the first time a given version runs, and never again.
///
/// The stored version is written *before* the panel opens, not after, so a
/// crash or a quit while reading it doesn't queue the same announcement up for
/// every launch that follows. Seen once is seen.
///
/// A fresh install has no stored version and so would be shown release notes
/// for a build it has no history with — the Mac has the same shape, but there
/// the empty string is also what a first launch sees, and it treats that as
/// "record the version, say nothing".
function showWhatsNewIfUpdated(version: string) {
  if (!version || version === 'unknown') return
  const seen = localStorage.getItem('lastSeenWhatsNewVersion')
  saveSetting('lastSeenWhatsNewVersion', version)
  if (seen === null || seen === version) return
  openReference('whatsnew')
}

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
  void renderFolderColorSettings()
  checkbox('setting-focus-editor').checked = settings.moveFocusToEditorOnEnter
  checkbox('setting-inbox-new').checked = settings.newNotesStartInInbox
  checkbox('setting-inbox-in-list').checked = settings.showInboxInMainList
  checkbox('setting-vault-counts').checked = settings.showFooterVaultCounts
  checkbox('setting-show-tags').checked = settings.showTagsInTitleBar
  checkbox('setting-show-folder-titlebar').checked = settings.showFolderInTitleBar
  checkbox('setting-folder-trailing').checked = settings.folderDotTrailing
  dropdown('setting-folder-display').value = settings.folderListDisplay
  // The folder-display choices only bite when subfolders are shown, so the
  // control is disabled otherwise — the same gating the Mac's picker uses.
  dropdown('setting-folder-display').disabled = !settings.includeSubfolders
  checkbox('setting-folder-trailing').disabled = !settings.includeSubfolders
  checkbox('setting-show-due-pill').checked = settings.showDuePill
  checkbox('setting-require-modifier').checked = settings.requireModifierForLinkClick
  checkbox('setting-show-interlinks').checked = settings.showBacklinks
  checkbox('setting-hide-on-blur').checked = settings.hideOnFocusLoss
  checkbox('setting-restore-focus').checked = settings.restoreFocusOnSummon
  dropdown('setting-date-style').value = settings.dateDisplayStyle
  dropdown('setting-link-preview').value = settings.linkPreview
  dropdown('setting-density').value = settings.listDensity
  dropdown('setting-text-size').value = String(settings.interfaceTextSize)
  checkbox('setting-fade-focus').checked = settings.fadeFocusHighlight
  checkbox('setting-taskbar').checked = settings.showInTaskbar
  checkbox('setting-bold-list').checked = settings.boldFileListText
  checkbox('setting-clock').checked = settings.showFooterClock
  checkbox('setting-clock-date').checked = settings.showFooterClockDate
  checkbox('setting-clock-fullscreen').checked = settings.showFooterClockOnlyWhenFullScreen
  dropdown('setting-clock-date-format').value = settings.footerClockDateFormat
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
  // A class rather than a style property, because it applies to the row's text
  // and not to a value the row is sized by — the Mac passes it into NoteRow as
  // the `bold` flag on every Text in the row.
  document.body.classList.toggle('bold-file-list', settings.boldFileListText)
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
bindToggle('setting-vault-counts', 'showFooterVaultCounts', () => void refreshVaultCounts())
bindToggle('setting-show-tags', 'showTagsInTitleBar', () => {
  const open = results.find((n) => n.id === openNoteId)
  renderTitleBarTags(open?.tags ?? [])
})
bindToggle('setting-show-folder-titlebar', 'showFolderInTitleBar', () => {
  const open = results.find((n) => n.id === openNoteId)
  renderTitleBarFolder(open?.subfolder ?? null)
})
bindToggle('setting-folder-trailing', 'folderDotTrailing', renderList)
bindToggle('setting-show-due-pill', 'showDuePill', () => {
  const open = results.find((n) => n.id === openNoteId)
  renderDueBadge(open?.due ?? null)
})
bindToggle('setting-require-modifier', 'requireModifierForLinkClick')
bindToggle('setting-show-interlinks', 'showBacklinks', renderInterlinks)
bindToggle('setting-hide-on-blur', 'hideOnFocusLoss')
bindToggle('setting-restore-focus', 'restoreFocusOnSummon')

dropdown('setting-date-style').onchange = (e) => {
  settings.dateDisplayStyle = (e.target as HTMLSelectElement).value
  saveSetting('dateDisplayStyle', settings.dateDisplayStyle)
  renderList()
}

dropdown('setting-folder-display').onchange = (e) => {
  settings.folderListDisplay = (e.target as HTMLSelectElement).value
  saveSetting('folderListDisplay', settings.folderListDisplay)
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
bindToggle('setting-clock-fullscreen', 'showFooterClockOnlyWhenFullScreen', startClockTick)
bindToggle('setting-bold-list', 'boldFileListText', applyChromeSettings)
dropdown('setting-clock-date-format').onchange = (e) => {
  settings.footerClockDateFormat = (e.target as HTMLSelectElement).value
  saveSetting('footerClockDateFormat', settings.footerClockDateFormat)
  startClockTick()
}

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
  // Folder colours only mean anything once folders are listed, so the pane
  // follows the toggle rather than waiting for Settings to be reopened.
  await renderFolderColorSettings()
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
    await alertModal('The trash is already empty.')
    return
  }
  const ok = await confirmModal(
    `Permanently delete ${waiting.length} note${waiting.length === 1 ? '' : 's'}? This cannot be undone.`,
    'Delete',
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
// `hide()` needs `core:window:allow-hide` granted explicitly — `core:default`
// covers only the read-only window calls — and a denied call rejects rather
// than throwing, so `void` on it discarded the one piece of evidence that
// anything was wrong. The window simply stayed put with a silent unhandled
// rejection behind it.
//
// The Mac hides on `didResignActiveNotification`, which is an *application*
// event: it fires when another app takes over, and explicitly not when focus
// moves between Envy's own windows, so this "can't accidentally hide the main
// window out from under those". Tauri has no app-level equivalent — focus is
// reported per window — so the same guarantee has to be reconstructed by asking
// whether any Envy window still holds focus before hiding. Without it, opening
// the pinned note would blur the main window and hide it, which is the exact
// accident the Mac's comment is about.
//
// The wait is what makes that check meaningful: at the moment the blur arrives
// the incoming window has not been marked focused yet, so an immediate poll
// reports nothing focused and hides regardless. Both calls used here are
// read-only and already covered by `core:default`.
async function anyEnvyWindowFocused(): Promise<boolean> {
  const windows = await getAllWindows()
  const focused = await Promise.all(windows.map((w) => w.isFocused().catch(() => false)))
  return focused.some(Boolean)
}

// While "Keep Envy on Top" is on, the auto-hide is suppressed — a window
// pinned above everything that vanished the moment you clicked away would fight
// itself. The tray toggle flips this over the `keep-on-top-changed` event, and
// the initial value is read at boot. Mirrors the Mac, where keepOnTop
// suppresses the same hide.
let keepOnTopActive = false
try {
  void listen<boolean>('keep-on-top-changed', (e) => {
    keepOnTopActive = e.payload
  })
} catch {
  // Outside Tauri (dev in a plain browser).
}

try {
  void getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
    if (focused || !settings.hideOnFocusLoss || keepOnTopActive) return
    // Settings is an in-page overlay rather than its own window, so it needs
    // its own guard — losing the panel mid-change would be the same accident.
    if (!settingsEl.classList.contains('hidden')) return
    try {
      await new Promise((resolve) => setTimeout(resolve, 120))
      if (await anyEnvyWindowFocused()) return
      await getCurrentWindow().hide()
    } catch (err) {
      console.error('could not hide on focus loss', err)
    }
  })
} catch {
  // Running outside Tauri (a plain browser during development).
}

async function boot() {
  syncTheme()
  // The on-top state is a Rust-side preference (toggled from the tray), so read
  // the remembered value once at startup for the hide-on-focus-loss guard.
  try {
    keepOnTopActive = await invoke<boolean>('keep_on_top')
  } catch {
    // Outside Tauri.
  }
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
  wikiLinkRangeAt,
  headingSlug,
  headingRangeForSlug,
  footnoteDefinitionRange,
  listContinuation,
  isListLine,
  renumberForTest: () => renumberEdits(view.state),
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
  // Exposed so a preference-driven repaint can be exercised the same way the
  // query one is — the pill's emoji lives outside the document, so nothing in
  // a transaction would otherwise show it changing.
  restyle,
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
  acceptCompletion,
  // The WebView2 dialog stand-ins, so their resolve behaviour (OK vs Cancel,
  // confirm vs prompt) can be exercised without the native dialogs that don't
  // exist in this webview.
  textPrompt,
  confirmModal,
  alertModal,
  arrowNavigate,
  renameTagFlow,
  // Folder-finish surfaces, verifiable without a backend: the Folder/Title
  // parse, the folder pivot, and the two folder markers.
  folderTargetedCreation,
  searchByFolder,
  renderTitleBarFolder,
  buildFolderIndicator,
  setKnownFoldersForTest: (f: string[]) => {
    knownFolders = f
  },
  setCatalogRowsForTest: (rows: CatalogRow[]) => {
    catalogRows = rows
  },
  setTagsForTest: (t: string[]) => {
    knownTags = t
  },
  setCompletionSourcesForTest: (tags: string[], folders: string[], titles: string[]) => {
    knownTags = tags
    knownFolders = folders
    // Through the setter so the ghost-link title set and a restyle come too.
    updateKnownTitles(titles)
  },
  isGhostLinkForTest,
  // The editor ghost completion, decided on the live editor state (no focus
  // needed, unlike the on-screen widget).
  editorGhostForTest: () => ghostRemainderForTest(view.state),
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
