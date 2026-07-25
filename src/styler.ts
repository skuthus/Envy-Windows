import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { Compartment, EditorState, Facet, Range, StateEffect, StateField } from '@codemirror/state'
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

/// The live search query, pushed in from the search box so matches can be
/// highlighted in the open note. Held in editor state rather than a module
/// variable so a query change goes through the normal update cycle and
/// triggers a redecorate like any other change.
export const setSearchQuery = StateEffect.define<string>()

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
  private view: EditorView | null = null
  private note: EmbedNote | null = null
  private editable = false
  private saveTimer: number | undefined
  private lastSynced = ''
  private body: HTMLElement | null = null
  /// Its own compartment, not a shared one: a module-level compartment is a
  /// single reconfigurable slot, so the first click into any embed would flip
  /// every embed on screen to editable at once.
  ///
  /// A compartment rather than `StateEffect.appendConfig`, because
  /// `EditorView.editable` resolves to the *first* value in the facet —
  /// appending `true` after the initial `false` would change nothing, and
  /// would do so silently.
  private readonly editableComp = new Compartment()

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
    window.clearTimeout(this.saveTimer)
    this.view?.destroy()
    this.view = null
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

    this.note = note
    this.lastSynced = note.content
    body.replaceChildren()

    this.view = new EditorView({
      state: EditorState.create({
        doc: note.content,
        extensions: [
          EditorView.lineWrapping,
          searchQueryField,
          // No embeds inside an embed — see `allowEmbeds`.
          allowEmbeds.of(false),
          envyStyler,
          // Starts read-only and flips on first click, so scrolling past an
          // embed while reading can never start typing into a different file.
          this.editableComp.of(EditorView.editable.of(false)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && this.editable) this.scheduleSave()
          }),
        ],
      }),
      parent: body,
    })

    body.addEventListener('mousedown', () => {
      if (this.editable || !this.view) return
      this.editable = true
      this.view.dispatch({
        effects: this.editableComp.reconfigure(EditorView.editable.of(true)),
      })
      // The click that flipped it is already spent, so focus has to be given
      // explicitly or the first click only ever arms the editor.
      this.view.focus()
    })
  }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined
      void this.commit()
    }, 400)
  }

  private async commit() {
    if (!this.host || !this.note || !this.view) return
    const content = this.view.state.doc.toString()
    if (content === this.lastSynced) return
    await this.host.save(this.note.id, content)
    this.lastSynced = content
  }

  /// Pull fresh content from the store, unless this embed is the one being
  /// typed into.
  async refresh() {
    if (!this.host || !this.view || this.editable) return
    const note = await this.host.resolve(this.title)
    if (!note || !this.view) return
    const current = this.view.state.doc.toString()
    if (note.content === current) return
    this.note = note
    this.lastSynced = note.content
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: note.content },
    })
  }
}

interface Mark {
  from: number
  to: number
  deco: Decoration
}

const mark = (cls: string) => Decoration.mark({ class: cls })
const hidden = Decoration.replace({})

const styles = {
  boldItalic: mark('envy-bold envy-italic'),
  bold: mark('envy-bold'),
  italic: mark('envy-italic'),
  strikethrough: mark('envy-strike'),
  code: mark('envy-code'),
  codeBlock: mark('envy-code-block'),
  link: mark('envy-link'),
  wikiLink: mark('envy-wikilink'),
  tag: mark('envy-tag'),
  blockquote: mark('envy-blockquote'),
  footnote: mark('envy-footnote'),
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

/// Ranges in `text` that the query matches, for highlighting.
///
/// Each word highlights independently: a scattered multi-word AND search has
/// no single contiguous phrase to find in the first place. Operators that name
/// nothing literal in a note's text — `date:`, `due:`, `link:`, `orphan:` —
/// highlight nothing, because there is nothing in the prose that corresponds
/// to them.
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
    if (
      lowered.startsWith('link:') ||
      lowered.startsWith('-link:') ||
      lowered === 'orphan:' ||
      lowered === 'linked:' ||
      lowered.startsWith('date:') ||
      lowered.startsWith('due:')
    ) {
      continue
    }

    if (token.startsWith('"') || token.startsWith('-"')) {
      // An exclusion highlights nothing. A *closed* quote matched on word
      // boundaries, so it highlights on word boundaries too — otherwise
      // "nee" would light up inside "needed" in a note that only matched the
      // whole word. An open, still-being-typed quote highlights as the
      // substring it matched as.
      if (token.startsWith('-')) continue
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
  const marks: Mark[] = []
  const doc = view.state.doc

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
      if (insideCode(s, s + m[0].length)) continue
      marks.push({ from: s, to: s + m[0].length, deco: styles.blockquote })
      marks.push({ from: s, to: s + m[1].length, deco: styles.marker })
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
      if (insideCode(s, s + m[0].length)) continue
      marks.push({ from: s, to: s + m[0].length, deco: styles.footnote })
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
    for (const [re, deco, markerLen] of inline) {
      for (const m of text.matchAll(re)) {
        const s = base + m.index!
        const e = s + m[0].length
        if (insideCode(s, e)) continue
        if (claimed.some(([x, y]) => s < y && e > x)) continue
        claimed.push([s, e])
        marks.push({ from: s, to: e, deco })
        if (!selectionTouches(view, s, e)) {
          marks.push({ from: s, to: s + markerLen, deco: hidden })
          marks.push({ from: e - (markerLen === 3 && re === P.embed ? 2 : markerLen), to: e, deco: hidden })
        } else {
          marks.push({ from: s, to: s + markerLen, deco: styles.marker })
          marks.push({ from: e - (markerLen === 3 && re === P.embed ? 2 : markerLen), to: e, deco: styles.marker })
        }
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
      }
    }

    for (const m of text.matchAll(P.footnoteReference)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      marks.push({ from: s, to: e, deco: styles.footnote })
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
    if (!tr.docChanged) return value.map(tr.changes)
    return buildEmbedDecorations(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function buildEmbedDecorations(state: EditorState): DecorationSet {
  if (!state.facet(allowEmbeds)) return Decoration.none
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
        tr.effects.some((e) => e.is(setSearchQuery)),
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
