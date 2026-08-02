import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { EditorState, Facet, Range, StateEffect, StateField } from '@codemirror/state'
import { createMiniNoteEditor, type MiniNoteEditor } from './mininote'
import { resolveDueToken, urgencyFor } from './due'

// --- Embeds -----------------------------------------------------------------

export interface EmbedNote {
  id: string
  title: string
  content: string
}

/// What an embed needs from the app to resolve and write a note. Supplied as a
/// facet so the styler keeps knowing nothing about Tauri or the note store.
export interface EmbedHost {
  resolve(title: string): Promise<EmbedNote | null>
  save(id: string, content: string): Promise<void>
  /// The note the host editor is currently showing, for the self-embed guard.
  currentNoteId(): string | null
}

export const embedHost = Facet.define<EmbedHost, EmbedHost | null>({
  combine: (values) => values[0] ?? null,
})

/// Whether this editor renders embeds at all.
///
/// The editor *inside* an embed sets this false. Without it, a note embedding
/// itself — or two notes embedding each other — would expand forever.
export const allowEmbeds = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? true,
})

/// The set of existing note titles, lowercased, so the styler can tell a
/// `[[link]]` that resolves from a "ghost" one whose target doesn't exist yet.
/// A getter returning a live set (like the completion sources), read fresh each
/// styling pass so a ghost un-ghosts the moment its target is created — the
/// styler just needs a `restyle` nudge when the set changes. Default resolves
/// everything, so an editor given no set (an embed's inner editor) never paints
/// a ghost.
export const existingTitles = Facet.define<() => Set<string>, () => Set<string>>({
  combine: (values) => values[0] ?? (() => new Set()),
})

/// Attachment extensions that count as resolvable on sight — a `[[pic.png]]`
/// or `![[pic.png]]` is a kept promise, not an unfilled one, so it never
/// ghosts. Mirrors envy-core's IMAGE_ATTACHMENT_EXTENSIONS.
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tiff', 'tif', 'bmp',
])

function isImageTarget(target: string): boolean {
  const dot = target.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXTENSIONS.has(target.slice(dot + 1).toLowerCase())
}

/// Whether a `[[link]]`'s target names something that exists — a note (case
/// insensitively) or an image attachment. An empty title set is treated as
/// "unknown, assume resolved" so a not-yet-loaded index (or an embed's inner
/// editor, which is given no set) never flashes every link as a ghost.
function titleResolves(target: string, titles: Set<string>): boolean {
  if (titles.size === 0) return true
  if (isImageTarget(target)) return true
  return titles.has(target.toLowerCase())
}

/// Test-only: would a `[[body]]` render as a ghost, given these existing
/// titles? Combines target extraction (alias/heading stripped), the image
/// exemption, and the case-insensitive lookup — the same decision the styler
/// makes per link. The inline styler is a ViewPlugin whose decorations only
/// materialise in a composited editor, so its ghosting can't be seen in a
/// headless pane; this exposes the decision so it can be.
export function isGhostLinkForTest(body: string, titles: string[]): boolean {
  const set = new Set(titles.map((t) => t.trim().toLowerCase()))
  return !titleResolves(wikiLinkTarget(body), set)
}

/// The live search query, pushed in from the search box so matches can be
/// highlighted in the open note. Held in editor state rather than a module
/// variable so a query change goes through the normal update cycle and
/// triggers a redecorate like any other change.
export const setSearchQuery = StateEffect.define<string>()

/// Plain-text mode: show the markdown as written, styling nothing.
///
/// A toggle rather than a separate view, so the text, cursor and scroll
/// position are all exactly where they were — the only thing that changes is
/// whether the styler runs.
export const setPlainText = StateEffect.define<boolean>()

/// Forces a restyle when something the decorations depend on changed outside
/// the document — a per-domain emoji, say, which lives in preferences rather
/// than in the text. Without it nothing in the transaction would tell the
/// plugin anything had changed, and the pill would keep its old mark until the
/// next keystroke.
export const restyle = StateEffect.define<null>()

export const plainTextField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPlainText)) return e.value
    return value
  },
})

/// Briefly marks a range that changed outside Envy, so the edit is noticed
/// without having to spot the diff yourself.
///
/// Uses the theme's highlight token — one "highlight" concept for everything
/// in the editor, rather than a second hardcoded colour nobody can change.
export const setFlash = StateEffect.define<{ from: number; to: number } | null>()

const flashMark = Decoration.mark({ class: 'envy-flash' })

export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        return e.value && e.value.to > e.value.from
          ? Decoration.set([flashMark.range(e.value.from, e.value.to)])
          : Decoration.none
      }
    }
    // Mapped through edits so a flash still marks the right text if something
    // else changes while it's fading.
    return value.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/// The span where two versions of a note differ — a common-prefix/suffix trim
/// rather than a real diff. It only has to be good enough to point the eye at
/// the right paragraph, and it's exact for the common case of one edited
/// region.
export function changedRange(before: string, after: string): { from: number; to: number } | null {
  if (before === after) return null
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  return { from: start, to: endAfter }
}

export const searchQueryField = StateField.define<string>({
  create: () => '',
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSearchQuery)) return e.value
    return value
  },
})

// Patterns transcribed verbatim from MarkdownStyler.swift. Every one of them
// is JS-compatible as written — including the lookbehinds, which WebView2
// supports since it's Chromium. That compatibility is the single biggest
// reason this port is tractable: the grammar doesn't have to be redesigned,
// only re-rendered.
const P = {
  embed: /!\[\[([^\[\]]+)\]\]/g,
  wikiLink: /\[\[([^\[\]]+)\]\]/g,
  boldItalic: /\*\*\*([^*\n]+)\*\*\*/g,
  bold: /\*\*([^*\n]+)\*\*/g,
  italic: /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
  strikethrough: /~~([^~\n]+)~~/g,
  highlight: /==([^=\n]+)==/g,
  code: /`([^`\n]+)`/g,
  fencedCodeBlock: /^```[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm,
  header: /^(#{1,6})[ \t]+(.*)$/gm,
  blockquote: /^(>[ \t]?)(.*)$/gm,
  horizontalRule: /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm,
  taskList: /^(\s*(?:[-*+][ \t]+)?)(\[[ xX]\])([ \t]+.*)$/gm,
  unorderedList: /^(\s*)([-*+])([ \t]+.*)$/gm,
  orderedList: /^(\s*)(\d+[.)])([ \t]+.*)$/gm,
  link: /(?<!!)\[([^\[\]]+)\]\(([^()\s]+)\)/g,
  autolinkBracket: /<(https?:\/\/[^\s>]+)>/g,
  bareURL: /(?<![(<])\bhttps?:\/\/[^\s<>()]+\b/g,
  footnoteDefinition: /^\[\^([^\]]+)\]:[ \t]*/gm,
  footnoteReference: /\[\^([^\]]+)\]/g,
  hashtag: /(?<![\w#])#[A-Za-z0-9_-]+/g,
  due: /(?<![\w])@(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[0-9/-]+)(?!\w)/gi,
  checkedTaskLine: /^\s*(?:[-*+][ \t]+)?\[[xX]\][ \t]+.*$/gm,
}

/// Shows a `*` bullet as an actual `•` glyph — the displayed character only;
/// the file still holds `*`, and the cursor/backspace still see it, since the
/// widget is revealed back to `*` whenever the caret is on it. Mirrors the
/// Mac's glyph substitution for `*`.
class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'envy-list-bullet'
    span.textContent = '•'
    return span
  }
}
const bulletWidget = Decoration.replace({ widget: new BulletWidget() })

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super()
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span')
    box.className = 'envy-checkbox' + (this.checked ? ' envy-checkbox-checked' : '')
    box.textContent = this.checked ? '✓' : ''
    box.setAttribute('aria-checked', String(this.checked))
    box.setAttribute('role', 'checkbox')
    // Matches MarkdownStyler.taskCheckboxRanges: the *glyph* (☑/☐) is a
    // floating overlay, but the checked state itself is real text on disk, and
    // toggling rewrites exactly one character — the one between the brackets,
    // not the whole "[x]" run. Keeping that one-character granularity means an
    // undo steps back over the toggle alone, and it keeps the file diff
    // identical to what the Mac build produces for the same action.
    box.onmousedown = (e) => {
      e.preventDefault()
      const toggleFrom = this.pos + 1
      view.dispatch({
        changes: { from: toggleFrom, to: toggleFrom + 1, insert: this.checked ? ' ' : 'x' },
      })
    }
    return box
  }
  ignoreEvent() {
    return false
  }
}

/// Every embed currently on screen, so the app can refresh them when the
/// source changes on disk. Widgets add themselves on mount and drop out on
/// destroy.
const mountedEmbeds = new Set<EmbedWidget>()

/// Re-reads every visible embed from the store — the "always current" half of
/// transclusion. An embed being edited is skipped, so a refresh can never yank
/// text out from under someone mid-sentence.
export function refreshEmbeds() {
  for (const w of mountedEmbeds) void w.refresh()
}

function embedMessage(text: string): HTMLElement {
  const p = document.createElement('div')
  p.className = 'envy-embed-message'
  p.textContent = text
  return p
}

class EmbedWidget extends WidgetType {
  private editor: MiniNoteEditor | null = null
  private body: HTMLElement | null = null

  constructor(
    readonly title: string,
    readonly host: EmbedHost | null,
    readonly hostNoteId: string | null,
  ) {
    super()
  }

  /// Reuse hinges on this. Returning false on every rebuild would tear down
  /// and recreate the nested editor on every keystroke in the host note,
  /// losing its cursor, its scroll position, and any edit in flight.
  eq(other: EmbedWidget) {
    return other.title === this.title && other.hostNoteId === this.hostNoteId
  }

  /// Events belong to the nested editor, not the host. Without this the outer
  /// view treats clicks inside the embed as clicks on an opaque widget and
  /// moves its own cursor instead.
  ignoreEvent() {
    return true
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    // A left rule rather than a box. A border frames the embed as a component
    // sitting in the note; a rule marks where the other note's text starts and
    // stops without pretending it's a different kind of thing — which is the
    // point of transclusion. Same device markdown already uses for
    // blockquotes.
    wrap.className = 'envy-embed'
    const body = document.createElement('div')
    body.className = 'envy-embed-body'
    wrap.append(body)
    this.body = body
    mountedEmbeds.add(this)
    void this.mount(body)
    return wrap
  }

  destroy() {
    mountedEmbeds.delete(this)
    this.editor?.destroy()
    this.editor = null
  }

  private async mount(body: HTMLElement) {
    if (!this.host) return
    let note: EmbedNote | null = null
    try {
      note = await this.host.resolve(this.title)
    } catch (e) {
      // A lookup that fails outright is not the same as a note that isn't
      // there, and silently leaving a bare rule on screen would be the worst
      // of both — it reads as an empty note rather than a problem.
      console.error(`could not resolve embed "${this.title}"`, e)
      if (this.body === body) body.replaceChildren(embedMessage('Could not load this note'))
      return
    }
    // The widget may have been torn down while the lookup was in flight.
    if (this.body !== body) return

    if (!note) {
      body.replaceChildren(embedMessage('Note not found'))
      return
    }
    // Rendering a second live, independently-editable copy of the buffer
    // you're already typing in means two debounced saves racing, each
    // silently discarding the other's work.
    if (note.id === this.hostNoteId) {
      body.replaceChildren(embedMessage('Already open above'))
      return
    }

    body.replaceChildren()
    // The same editor the link preview uses — one code path for "show another
    // note's content and let me click into it".
    const host = this.host
    this.editor = createMiniNoteEditor(body, note, (id, content) => host.save(id, content))
  }

  /// Pull fresh content from the store, unless this embed is the one being
  /// typed into.
  async refresh() {
    const editor = this.editor
    if (!this.host || !editor || editor.isEditable()) return
    const note = await this.host.resolve(this.title)
    if (!note || this.editor !== editor) return
    if (note.content === editor.view.state.doc.toString()) return
    editor.setContent(note.content)
  }
}

interface Mark {
  from: number
  to: number
  deco: Decoration
}

const mark = (cls: string) => Decoration.mark({ class: cls })
const hidden = Decoration.replace({})

// --- Link pills --------------------------------------------------------------

/// The domain a bare URL should show — its host, with any leading `www.`
/// dropped. `null` for a string with no `://host`, which then falls back to
/// plain full-URL styling rather than collapsing to nothing.
///
/// Parsed by hand rather than with `URL`, which is lenient in ways that hurt
/// here: it happily accepts a truncated URL mid-typing and invents a host.
export function urlDomain(urlText: string): string | null {
  const sep = urlText.indexOf('://')
  if (sep < 0) return null
  let start = sep + 3
  let end = urlText.length
  for (let i = start; i < urlText.length; i++) {
    const c = urlText[i]
    if (c === '/' || c === '?' || c === '#') {
      end = i
      break
    }
  }
  if (end - start > 4 && urlText.slice(start, start + 4).toLowerCase() === 'www.') {
    start += 4
  }
  return end > start ? urlText.slice(start, end) : null
}

/// Per-domain emoji for link pills — a preference, not note content.
///
/// The note holds the plain URL; the emoji is presentation keyed by the site,
/// so every link to one domain carries the same mark and nothing is written
/// into the file. Read straight from storage rather than passed in, because a
/// widget is rebuilt on every restyle anyway and threading it through the
/// facets would buy nothing.
function domainEmoji(domain: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem('domainEmojis') ?? '{}') as Record<string, string>
    return all[domain] ?? null
  } catch {
    return null
  }
}

/// A bare URL collapsed to `emoji domain ↗`.
class UrlPillWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly domain: string,
    /// Captured at build time rather than read in `toDOM`, so that `eq` can see
    /// it. A widget whose `eq` returns true keeps its existing DOM and is never
    /// asked to build again — so comparing only the URL and domain meant a
    /// newly chosen emoji did not appear until something else forced the pill
    /// to be rebuilt, which is exactly the symptom: it changed after leaving
    /// the note and coming back.
    readonly emoji: string | null,
  ) {
    super()
  }

  eq(other: UrlPillWidget) {
    return (
      other.url === this.url && other.domain === this.domain && other.emoji === this.emoji
    )
  }

  toDOM() {
    const pill = document.createElement('span')
    pill.className = 'envy-url-pill'
    pill.title = this.url
    const emoji = this.emoji
    if (emoji) {
      const e = document.createElement('span')
      e.className = 'envy-url-emoji'
      e.textContent = emoji
      pill.append(e)
    }
    const label = document.createElement('span')
    label.className = 'envy-url-domain'
    label.textContent = this.domain
    pill.append(label)
    const arrow = document.createElement('span')
    arrow.className = 'envy-url-arrow'
    arrow.textContent = '↗'
    pill.append(arrow)
    // The URL rides along so the click and right-click handlers in the app can
    // act without re-parsing the document.
    pill.dataset.url = this.url
    pill.dataset.domain = this.domain
    return pill
  }

  /// The pill handles its own clicks — without this the view treats them as
  /// clicks on an opaque widget and just moves the caret.
  ignoreEvent() {
    return true
  }
}

const styles = {
  boldItalic: mark('envy-bold envy-italic'),
  bold: mark('envy-bold'),
  italic: mark('envy-italic'),
  strikethrough: mark('envy-strike'),
  highlight: mark('envy-highlight-mark'),
  code: mark('envy-code'),
  codeBlock: mark('envy-code-block'),
  link: mark('envy-link'),
  wikiLink: mark('envy-wikilink'),
  /// A `[[link]]` whose target doesn't exist yet — the same link, dimmed, so a
  /// glance separates kept promises from IOUs. Still clickable (click creates
  /// the note), same as the Mac.
  ghostLink: mark('envy-wikilink envy-wikilink-ghost'),
  tag: mark('envy-tag'),
  blockquote: mark('envy-blockquote'),
  blockquoteText: mark('envy-blockquote-text'),
  footnote: mark('envy-footnote'),
  /// A footnote *reference* `[^1]` — the label rendered as a small raised
  /// superscript in the link colour, with the `[^`/`]` hidden, matching the Mac.
  footnoteRef: mark('envy-footnote-ref'),
  /// A footnote *definition*'s number, superscripted like the reference but in
  /// the dim footnote colour (it's the passive end, not a clickable link).
  footnoteDefNum: mark('envy-footnote-defnum'),
  /// A list marker (`-`/`+`/`*` or `1.`) dimmed so the content reads first.
  listMarker: mark('envy-list-marker'),
  completedTask: mark('envy-completed-task'),
  marker: mark('envy-marker'),
  hr: mark('envy-hr'),
} as const

/// Envy hides markup only when the cursor is elsewhere — 1.3.0's "a link stays
/// editable once your cursor is inside it". That single rule is what makes a
/// no-preview-pane editor usable: without it, styling fights the person typing.
///
/// An *unfocused* editor reveals nothing at all. A CodeMirror state always
/// carries a selection, and a fresh one sits at position 0 — so without this
/// check, any document beginning with a heading showed its `#` until something
/// moved the cursor. Most visible inside an embed, which is unfocused by
/// design until clicked, but the host editor had it too on every note that
/// opened with a heading.
///
/// The Mac does the same thing by passing its selection only while the text
/// view is first responder, and nil otherwise.
function selectionTouches(view: EditorView, from: number, to: number): boolean {
  if (!view.hasFocus) return false
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/// The same quote-aware tokenizer the search itself uses, so what lights up
/// matches what was searched. A naive space split would treat a quoted phrase
/// as the literal string `"build"`, quotes and all, and highlight nothing.
function tokenizeQuery(q: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of q) {
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === ' ' && !inQuotes) {
      if (current) out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) out.push(current)
  return out
}

/// Operators that name nothing a note's text actually contains.
///
/// They filter on when a note was touched, where it sits, what points at it,
/// whether it has an unfinished task — none of which is written anywhere in
/// the prose. Highlighting them would light up the literal word in any note
/// unlucky enough to contain it: a note mentioning "todo:" would glow for a
/// `todo:` search that matched it for an entirely different reason.
///
/// `tag:` is deliberately absent. A tag *is* in the text, so it is handled
/// below by highlighting the matched part of each qualifying `#tag`. `title:`
/// is absent for the same reason — its argument is real title text, so it falls
/// through to the ordinary highlighter.
const NON_LITERAL_OPERATORS =
  /^(date|stale|due|link|interlink|folder|img|embed|ghost|todo|ai|inbox|template|trash|orphan|linked):/

/// Ranges in `text` that the query matches, for highlighting.
///
/// Each word highlights independently: a scattered multi-word AND search has
/// no single contiguous phrase to find in the first place. Operators that name
/// nothing literal in a note's text highlight nothing, because there is
/// nothing in the prose that corresponds to them — see
/// `NON_LITERAL_OPERATORS`.
function searchMatchRanges(text: string, query: string): Array<[number, number]> {
  const trimmed = query.trim()
  if (!trimmed || !text) return []
  const out: Array<[number, number]> = []

  const addPattern = (pattern: string) => {
    let re: RegExp
    try {
      // The `u` flag is load-bearing, not decoration: `\p{L}` and `\p{N}` are
      // only Unicode property escapes in unicode mode. Without it they parse
      // as a character class of the literal characters p, {, L, } — so the
      // word-boundary guard silently stops guarding, and a closed-quote search
      // for "nee" lights up the "nee" inside "needed".
      re = new RegExp(pattern, 'gui')
    } catch {
      return
    }
    for (const m of text.matchAll(re)) {
      if (m[0].length > 0) out.push([m.index!, m.index! + m[0].length])
    }
  }
  const addLiteral = (literal: string) => addPattern(escapeRegex(literal))

  for (const token of tokenizeQuery(trimmed)) {
    const lowered = token.toLowerCase()
    // An exclusion highlights nothing — the same rule the quoted branch below
    // states and applies. It holds for every kind: `-oranges`, `-tag:x`,
    // `-due:overdue`. Without this they fell through to the literal branch and
    // were searched for verbatim, hyphen and all.
    if (lowered.startsWith('-') && lowered.length > 1) continue
    if (NON_LITERAL_OPERATORS.test(lowered)) continue

    if (token.startsWith('"')) {
      // A *closed* quote matched on word boundaries, so it highlights on word
      // boundaries too — otherwise "nee" would light up inside "needed" in a
      // note that only matched the whole word. An open, still-being-typed
      // quote highlights as the substring it matched as.
      //
      // `-"phrase"` no longer reaches here: the exclusion check above catches
      // every kind of exclusion, this one included.
      const phrase = token.replace(/^"/, '').replace(/"$/, '')
      if (!phrase) continue
      if (token.length >= 2 && token.endsWith('"')) {
        addPattern(`(?<![\\p{L}\\p{N}_])${escapeRegex(phrase)}(?![\\p{L}\\p{N}_])`)
      } else {
        addLiteral(phrase)
      }
      continue
    }

    if (lowered.startsWith('tag:')) {
      // "tag:techn" matches "#technology", so highlight just the matched
      // substring inside each qualifying tag rather than the tag's whole
      // extent — consistent with a plain search only lighting up what was
      // actually typed.
      const name = lowered.slice('tag:'.length)
      if (!name) continue
      for (const m of text.matchAll(/(?<![\w#])#[A-Za-z0-9_-]+/g)) {
        const at = m[0].toLowerCase().indexOf(name)
        if (at < 0) continue
        out.push([m.index! + at, m.index! + at + name.length])
      }
      continue
    }

    addLiteral(token)
  }
  return out
}

/// The note a `[[…]]` body points at — alias and heading stripped. Mirrors
/// `WikiLink::parse` in envy-core.
function wikiLinkTarget(body: string): string {
  return body.split('|')[0].split('#')[0].trim()
}

function buildDecorations(view: EditorView): DecorationSet {
  // Plain-text mode styles nothing at all — not even the search highlight,
  // since the point is to see the file exactly as it is.
  if (view.state.field(plainTextField, false)) return Decoration.none

  const marks: Mark[] = []
  const doc = view.state.doc
  // The existing-title set for the ghost-link check, read once per pass.
  const titles = view.state.facet(existingTitles)()

  // Expand each visible range out to whole lines — the ^-anchored patterns are
  // wrong on a slice that starts mid-line, and CM6's visibleRanges make no
  // line guarantees.
  //
  // Then MERGE the expanded ranges. Two adjacent visible ranges can meet
  // inside a single line, and expanding both to that line's bounds makes them
  // overlap — so the line would be scanned twice and every decoration on it
  // emitted twice. Duplicate `replace` decorations over identical ranges make
  // CM6 render the markup it was told to hide. Whether any given line lands on
  // such a seam depends on scroll offset and pane height, which is exactly why
  // this surfaced on one heading and not an identical one further down.
  const spans: Array<[number, number]> = []
  for (const { from, to } of view.visibleRanges) {
    const start = doc.lineAt(from).from
    const end = doc.lineAt(to).to
    const last = spans[spans.length - 1]
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end)
    } else {
      spans.push([start, end])
    }
  }

  for (const [base, spanEnd] of spans) {
    const text = doc.sliceString(base, spanEnd)

    // Code wins over everything nested inside it. Collected first so later
    // scans can skip anything overlapping — mirrors MarkdownStyler's own
    // precedence, where a `*` inside a fence is not emphasis.
    const codeRanges: Array<[number, number]> = []
    const claimCode = (a: number, b: number) => codeRanges.push([a, b])
    const insideCode = (a: number, b: number) =>
      codeRanges.some(([x, y]) => a < y && b > x)

    for (const m of text.matchAll(P.fencedCodeBlock)) {
      const s = base + m.index!
      const e = s + m[0].length
      claimCode(s, e)
      marks.push({ from: s, to: e, deco: styles.codeBlock })
    }
    for (const m of text.matchAll(P.code)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      claimCode(s, e)
      marks.push({ from: s, to: e, deco: styles.code })
      if (!selectionTouches(view, s, e)) {
        marks.push({ from: s, to: s + 1, deco: hidden })
        marks.push({ from: e - 1, to: e, deco: hidden })
      }
    }

    // Retirement ranges — a due token inside "~~...~~" or on a checked task
    // line is retired, exactly as Note.activeDueDates computes it. Rendering
    // has to agree with the model or the pill and the search disagree.
    const retired: Array<[number, number]> = []
    for (const m of text.matchAll(P.strikethrough)) {
      retired.push([base + m.index!, base + m.index! + m[0].length])
    }
    for (const m of text.matchAll(P.checkedTaskLine)) {
      retired.push([base + m.index!, base + m.index! + m[0].length])
    }
    const isRetired = (a: number, b: number) =>
      retired.some(([x, y]) => a < y && b > x)

    // --- Block constructs -------------------------------------------------
    for (const m of text.matchAll(P.header)) {
      const s = base + m.index!
      if (insideCode(s, s + m[0].length)) continue
      const level = m[1].length
      const markerEnd = s + m[1].length + (m[0].length - m[1].length - m[2].length)
      marks.push({ from: s, to: s + m[0].length, deco: mark(`envy-h${level}`) })
      if (!selectionTouches(view, s, s + m[0].length)) {
        marks.push({ from: s, to: markerEnd, deco: hidden })
      } else {
        marks.push({ from: s, to: markerEnd, deco: styles.marker })
      }
    }

    for (const m of text.matchAll(P.blockquote)) {
      const s = base + m.index!
      const end = s + m[0].length
      if (insideCode(s, end)) continue
      // A bare ">" with nothing after it is left alone entirely, as on the Mac
      // — no rule, no indent, no collapse. There is no quote yet, only the
      // character that starts one, and hiding it would delete what you just
      // typed from under the cursor.
      if (m[2].length === 0) continue
      const markerEnd = s + m[1].length
      marks.push({ from: s, to: end, deco: styles.blockquote })
      // Italic on the content alone, not the marker — the Mac applies the
      // italic font to its contentRange only, the same way every other element
      // here confines marker colour to the marker's own range.
      marks.push({ from: markerEnd, to: end, deco: styles.blockquoteText })
      // The ">" is markup, so it collapses once the cursor leaves the line and
      // comes back the moment it returns — exactly as headings and task boxes
      // already do. Leaving it permanently visible was the odd one out.
      if (!selectionTouches(view, s, end)) {
        marks.push({ from: s, to: markerEnd, deco: hidden })
      } else {
        marks.push({ from: s, to: markerEnd, deco: styles.marker })
      }
    }

    for (const m of text.matchAll(P.horizontalRule)) {
      const s = base + m.index!
      if (insideCode(s, s + m[0].length)) continue
      marks.push({ from: s, to: s + m[0].length, deco: styles.hr })
    }

    for (const m of text.matchAll(P.taskList)) {
      const s = base + m.index!
      const lineEnd = s + m[0].length
      if (insideCode(s, lineEnd)) continue
      const boxFrom = s + m[1].length
      const checked = m[2][1] !== ' '
      if (!selectionTouches(view, boxFrom, boxFrom + 3)) {
        marks.push({
          from: boxFrom,
          to: boxFrom + 3,
          deco: Decoration.replace({ widget: new CheckboxWidget(checked, boxFrom) }),
        })
      }
      if (checked) {
        marks.push({ from: boxFrom + 3, to: lineEnd, deco: styles.completedTask })
      }
    }

    for (const m of text.matchAll(P.footnoteDefinition)) {
      const s = base + m.index!
      const markerEnd = s + m[0].length
      if (insideCode(s, markerEnd)) continue
      // The definition text (everything after the "[^n]:" marker) reads as a
      // small, dim footnote. The marker collapses to just its number, shown as
      // a superscript so you can tell which reference a definition answers to —
      // the "[^" and "]:" hide, the number stays. (The Mac hides the number
      // too; keeping it is the clearer call.) Revealed raw when the caret's on.
      const lineEnd = doc.lineAt(s).to
      if (lineEnd > markerEnd) {
        marks.push({ from: markerEnd, to: lineEnd, deco: styles.footnote })
      }
      if (!selectionTouches(view, s, markerEnd)) {
        const numFrom = s + 2 // after "[^"
        const numTo = numFrom + m[1].length
        marks.push({ from: s, to: numFrom, deco: hidden })
        marks.push({ from: numFrom, to: numTo, deco: styles.footnoteDefNum })
        marks.push({ from: numTo, to: markerEnd, deco: hidden })
      } else {
        marks.push({ from: s, to: markerEnd, deco: styles.marker })
      }
    }

    // --- Inline constructs ------------------------------------------------
    // Order matters and mirrors the Swift: *** before ** before *, and embed
    // before wikiLink so "![[X]]" isn't read as a bare "[[X]]" with a stray "!".
    const inline: Array<[RegExp, Decoration, number]> = [
      [P.embed, styles.wikiLink, 3],
      [P.wikiLink, styles.wikiLink, 2],
      [P.boldItalic, styles.boldItalic, 3],
      [P.bold, styles.bold, 2],
      [P.italic, styles.italic, 1],
      [P.strikethrough, styles.strikethrough, 2],
    ]
    const claimed: Array<[number, number]> = []
    for (const [re, baseDeco, markerLen] of inline) {
      for (const m of text.matchAll(re)) {
        const s = base + m.index!
        const e = s + m[0].length
        if (insideCode(s, e)) continue
        if (claimed.some(([x, y]) => s < y && e > x)) continue
        claimed.push([s, e])
        // A `[[link]]` or `![[embed]]` whose target doesn't exist yet is
        // dimmed. m[1] is the body; the marker hides/reveals still land on the
        // brackets, so only the body carries the ghost colour — as on the Mac.
        const deco =
          (re === P.wikiLink || re === P.embed) &&
          !titleResolves(wikiLinkTarget(m[1]), titles)
            ? styles.ghostLink
            : baseDeco
        marks.push({ from: s, to: e, deco })
        if (!selectionTouches(view, s, e)) {
          marks.push({ from: s, to: s + markerLen, deco: hidden })
          marks.push({ from: e - (markerLen === 3 && re === P.embed ? 2 : markerLen), to: e, deco: hidden })
          // `[[Note|shown]]` shows only "shown": collapse the "Note|" the same
          // way a `[text](url)` hides its target, so an aliased link reads as
          // its alias. A `#heading` (no pipe) is left as written, like the Mac.
          if (re === P.wikiLink) {
            const pipe = m[1].indexOf('|')
            if (pipe !== -1) {
              marks.push({ from: s + markerLen, to: s + markerLen + pipe + 1, deco: hidden })
            }
          }
        } else {
          marks.push({ from: s, to: s + markerLen, deco: styles.marker })
          marks.push({ from: e - (markerLen === 3 && re === P.embed ? 2 : markerLen), to: e, deco: styles.marker })
        }
      }
    }

    // `==highlight==` is the last inline pass, as on the Mac: everything else
    // has claimed its ranges by now, and the search pass still paints after.
    // The two share a colour, so a marked word that is also a search match
    // simply stays marked — the honest outcome of reusing one colour for both.
    // Inline code and fenced blocks are already claimed, so `a == b` inside
    // backticks is left alone for free.
    //
    // It gets its own pass rather than joining the loop above because the
    // background belongs to the *content* alone, never the markers — the Mac
    // applies it to `match.range(at: 1)` for the same reason. Painting the whole
    // match instead puts the revealed `==` on the highlight, where the dim
    // marker colour is chosen to be quiet against the page and comes out barely
    // readable against amber.
    for (const m of text.matchAll(P.highlight)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      if (claimed.some(([x, y]) => s < y && e > x)) continue
      claimed.push([s, e])
      marks.push({ from: s + 2, to: e - 2, deco: styles.highlight })
      if (!selectionTouches(view, s, e)) {
        marks.push({ from: s, to: s + 2, deco: hidden })
        marks.push({ from: e - 2, to: e, deco: hidden })
      } else {
        marks.push({ from: s, to: s + 2, deco: styles.marker })
        marks.push({ from: e - 2, to: e, deco: styles.marker })
      }
    }

    for (const m of text.matchAll(P.link)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      marks.push({ from: s, to: e, deco: styles.link })
      if (!selectionTouches(view, s, e)) {
        marks.push({ from: s, to: s + 1, deco: hidden })
        marks.push({ from: s + 1 + m[1].length, to: e, deco: hidden })
      }
    }

    for (const re of [P.autolinkBracket, P.bareURL]) {
      for (const m of text.matchAll(re)) {
        const s = base + m.index!
        const e = s + m[0].length
        if (insideCode(s, e)) continue
        if (claimed.some(([x, y]) => s < y && e > x)) continue
        marks.push({ from: s, to: e, deco: styles.link })

        // A bare URL collapses to a pill showing just its domain. Bracketed
        // autolinks keep their full text: someone wrote the brackets to say
        // "this is a URL", and hiding it would undo that.
        if (re !== P.bareURL) continue
        const domain = urlDomain(m[0])
        // No `://host` to show means nothing to collapse to, so it stays a
        // plain full-length link rather than becoming an empty pill.
        if (!domain) continue
        // Revealed while the cursor is inside it, exactly like every other
        // marker — a pill you cannot put the caret into is a link you cannot
        // edit.
        if (selectionTouches(view, s, e)) continue
        marks.push({
          from: s,
          to: e,
          deco: Decoration.replace({
            widget: new UrlPillWidget(m[0], domain, domainEmoji(domain)),
          }),
        })
      }
    }

    for (const m of text.matchAll(P.footnoteReference)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      // A definition marker "[^1]:" is styled by the definition pass above, not
      // here — the colon straight after the "]" is what tells them apart.
      if (doc.sliceString(e, e + 1) === ':') continue
      const labelFrom = s + 2 // after "[^"
      const labelTo = e - 1 // before "]"
      marks.push({ from: labelFrom, to: labelTo, deco: styles.footnoteRef })
      // Hide the "[^" and "]" so the reference reads as a bare superscript,
      // revealing them (as markers) only when the cursor is inside — the same
      // hide/reveal every other markup gets.
      if (!selectionTouches(view, s, e)) {
        marks.push({ from: s, to: labelFrom, deco: hidden })
        marks.push({ from: labelTo, to: e, deco: hidden })
      } else {
        marks.push({ from: s, to: labelFrom, deco: styles.marker })
        marks.push({ from: labelTo, to: e, deco: styles.marker })
      }
    }

    // List markers: dim the bullet/number so the content leads, and show a `*`
    // as a `•` glyph. The marker char on disk is untouched; the `*` reveals
    // back when the caret is on it. Mirrors the Mac's listMarkerColor + glyph.
    for (const m of text.matchAll(P.unorderedList)) {
      const ms = base + m.index! + m[1].length
      const me = ms + 1
      if (insideCode(ms, me)) continue
      if (m[2] === '*' && !selectionTouches(view, ms, me)) {
        marks.push({ from: ms, to: me, deco: bulletWidget })
      } else {
        marks.push({ from: ms, to: me, deco: styles.listMarker })
      }
    }
    for (const m of text.matchAll(P.orderedList)) {
      const ms = base + m.index! + m[1].length
      const me = ms + m[2].length
      if (insideCode(ms, me)) continue
      marks.push({ from: ms, to: me, deco: styles.listMarker })
    }

    for (const m of text.matchAll(P.hashtag)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      marks.push({ from: s, to: e, deco: styles.tag })
    }

    for (const m of text.matchAll(P.due)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      if (isRetired(s, e)) continue
      const date = resolveDueToken(m[1])
      if (!date) continue // unparseable just means no due date, never a crash
      marks.push({ from: s, to: e, deco: mark(`envy-due envy-due-${urgencyFor(date)}`) })
    }
  }

  // Search highlights go on last so they layer over whatever styling a span
  // already has — a match can land on bold text, a link, a tag or plain prose,
  // and it should read as a match in every one of those.
  const query = view.state.field(searchQueryField, false) ?? ''
  if (query.trim()) {
    for (const [base, spanEnd] of spans) {
      const text = doc.sliceString(base, spanEnd)
      for (const [s, e] of searchMatchRanges(text, query)) {
        marks.push({ from: base + s, to: base + e, deco: mark('envy-search-match') })
      }
    }
  }

  marks.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(
    marks.map((m) => m.deco.range(m.from, m.to)) as Range<Decoration>[],
    true,
  )
}

/// Embed widgets, as a StateField rather than part of the view plugin.
///
/// Not a stylistic choice: CodeMirror rejects block decorations supplied by a
/// plugin outright ("Block decorations may not be specified via plugins"),
/// because a block changes the document's line layout and the viewport is
/// measured from that layout — a plugin that both reads the viewport and
/// changes line heights would be defining its own input.
///
/// The practical consequence is that this scans the whole document rather than
/// just the visible range. That's affordable here in a way it wouldn't be for
/// the inline styling: embeds are rare, and the scan is one regex pass rather
/// than the twenty-odd the styler runs.
const embedDecorations = StateField.define<DecorationSet>({
  create: (state) => buildEmbedDecorations(state),
  update(value, tr) {
    const modeChanged = tr.effects.some((e) => e.is(setPlainText))
    if (!tr.docChanged && !modeChanged) return value.map(tr.changes)
    return buildEmbedDecorations(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function buildEmbedDecorations(state: EditorState): DecorationSet {
  if (!state.facet(allowEmbeds) || state.field(plainTextField, false)) return Decoration.none
  const host = state.facet(embedHost)
  const hostNoteId = host?.currentNoteId() ?? null
  const text = state.doc.toString()

  const ranges: Range<Decoration>[] = []
  for (const m of text.matchAll(P.embed)) {
    const title = wikiLinkTarget(m[1])
    if (!title) continue
    // Placed after the whole line rather than at the match, so an embed
    // mentioned mid-sentence doesn't cut the sentence in half. The `![[…]]`
    // stays ordinary text, styled as a link.
    const line = state.doc.lineAt(m.index!)
    ranges.push(
      Decoration.widget({
        widget: new EmbedWidget(title, host, hostNoteId),
        block: true,
        side: 1,
      }).range(line.to),
    )
  }
  return Decoration.set(ranges, true)
}

const stylerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      // Selection changes matter as much as doc changes — the reveal-on-cursor
      // rule above is driven entirely by where the cursor is. A query change
      // arrives as a bare effect with no doc or selection change at all, so it
      // has to be checked for explicitly or the highlights never appear.
      const queryChanged = update.transactions.some((tr) =>
        tr.effects.some(
          (e) => e.is(setSearchQuery) || e.is(setPlainText) || e.is(restyle),
        ),
      )
      // Focus is an input to the reveal rule now, so gaining or losing it has
      // to redecorate — otherwise markers stay revealed after clicking away.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        queryChanged
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

/// The whole styling layer: inline marks from a view plugin (viewport-scoped,
/// because that's where the cost is) and embed blocks from a state field
/// (because CodeMirror requires it).
export const envyStyler = [embedDecorations, stylerPlugin]
