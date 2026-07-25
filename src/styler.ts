import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { Range } from '@codemirror/state'
import { resolveDueToken, urgencyFor } from './due'

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
/// no-preview-pane editor usable, and it's the behavior most worth proving in
/// this spike: without it, styling actively fights the person typing.
function selectionTouches(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
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

  marks.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(
    marks.map((m) => m.deco.range(m.from, m.to)) as Range<Decoration>[],
    true,
  )
}

export const envyStyler = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      // Selection changes matter as much as doc changes — the reveal-on-cursor
      // rule above is driven entirely by where the cursor is.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)
