//! Inline ghost-text completion inside the editor, for `[[wiki-links]]` and
//! `#tags` — the grey suffix that appears as you type and is accepted with Tab
//! or the Right arrow.
//!
//! Ported from the Mac's `updateWikiLinkGhostSuggestion` /
//! `updateTagGhostSuggestion`. Two rules, one at a time:
//!
//! - **Wiki-link**: an open `[[` on the current line with no `]]` before the
//!   caret, the caret at the end of the query (nothing but a closing `]]`
//!   ahead), completes against note titles most-recent-first.
//! - **Tag**: a `#` at a word boundary with an all-tag-body fragment after it
//!   and no tag character under the caret, completes against tags most-used
//!   first.
//!
//! An *open* `[[` commits to link completion — it never falls through to a tag.
//! The tag rule only applies when there is no open `[[` on the line.

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
} from '@codemirror/view'
import { type EditorState, Facet, Prec } from '@codemirror/state'

/// The suggestion pools, read fresh each time so they track edits and moves
/// without the extension having to be reconfigured. `titles` is note titles
/// most-recently-modified first; `tags` is tag names most-used first — the same
/// two lists the search box completes from.
export interface CompletionSources {
  titles: string[]
  tags: string[]
}

export const completionSources = Facet.define<
  () => CompletionSources,
  () => CompletionSources
>({
  combine: (values) => values[0] ?? (() => ({ titles: [], tags: [] })),
})

/// A tag-body character: what may appear *after* the `#`. Matches the Mac's
/// `isTagBodyChar` (alphanumeric, `_`, `-`).
function isTagBody(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch)
}

/// A character that, immediately before a `#`, stops it from opening a tag —
/// so `a#b` and `##h` are not tag starts. The Mac's `blocksTagStart`
/// (alphanumeric, `_`, `#`).
function blocksTagStart(ch: string): boolean {
  return /[A-Za-z0-9_#]/.test(ch)
}

/// The remainder to show after the caret, or null. A pure function of the
/// state, so the plugin and the accept command agree on exactly one answer.
function ghostRemainder(state: EditorState): string | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const pos = sel.head
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const sources = state.facet(completionSources)()

  // --- Wiki-link ---------------------------------------------------------
  const lastOpen = before.lastIndexOf('[[')
  if (lastOpen !== -1) {
    const between = before.slice(lastOpen + 2)
    // A `]]` between the opener and the caret means that link is already
    // closed — fall through to the tag rule below. Anything else keeps us in
    // link context and commits to it.
    if (!between.includes(']]')) {
      const query = between
      if (!query || query.includes('[') || query.includes(']')) return null
      // The caret must sit at the end of the query — either the end of the
      // line, or immediately before the closing `]]`. Text in between means
      // the user is editing a finished link, not extending a new one.
      const after = state.doc.sliceString(pos, line.to)
      const closeAhead = after.indexOf(']]')
      const trailing = closeAhead === -1 ? '' : after.slice(0, closeAhead)
      if (trailing !== '') return null
      const lowered = query.toLowerCase()
      const match = sources.titles.find(
        (t) => t.toLowerCase().startsWith(lowered) && t.length > query.length,
      )
      return match ? match.slice(query.length) : null
    }
  }

  // --- Tag ---------------------------------------------------------------
  const lastHash = before.lastIndexOf('#')
  if (lastHash === -1) return null
  // The `#` must open a tag: a word character (or another `#`) right before it
  // disqualifies it.
  if (lastHash > 0 && blocksTagStart(before[lastHash - 1])) return null
  const fragment = before.slice(lastHash + 1)
  if (!fragment) return null
  // Every character since the `#` must be a tag-body character — a space or
  // punctuation means the `#` was not the start of the tag being typed.
  if (![...fragment].every(isTagBody)) return null
  // And the caret must be at the fragment's end: a tag character right after it
  // means we are in the middle of an existing tag, not extending its tail.
  const charAfter = state.doc.sliceString(pos, pos + 1)
  if (charAfter && isTagBody(charAfter)) return null

  const lowered = fragment.toLowerCase()
  const match = sources.tags.find(
    (t) => t.startsWith(lowered) && t.length > fragment.length,
  )
  return match ? match.slice(fragment.length) : null
}

/// The grey suffix drawn at the caret. An `atomic`-free widget with `side: 1`
/// so it sits after the cursor without becoming part of the document.
class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: GhostWidget) {
    return other.text === this.text
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ghost-completion'
    span.textContent = this.text
    return span
  }
  ignoreEvent() {
    return false
  }
}

const ghostPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    /// The suffix currently shown, so the accept command can insert it without
    /// recomputing (and can be sure it inserts exactly what is on screen).
    remainder: string | null = null

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate) {
      // Recompute on anything that could move the caret or change the text —
      // and on focus, since a blurred editor should show nothing.
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        this.decorations = this.build(update.view)
      }
    }

    build(view: EditorView): DecorationSet {
      this.remainder = null
      if (!view.hasFocus) return Decoration.none
      const text = ghostRemainder(view.state)
      if (!text) return Decoration.none
      this.remainder = text
      const pos = view.state.selection.main.head
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(pos),
      ])
    }
  },
  { decorations: (v) => v.decorations },
)

/// Inserts the visible ghost at the caret. Returns false when there is none, so
/// Tab and the Right arrow keep their normal meaning the rest of the time.
function acceptGhost(view: EditorView): boolean {
  const plugin = view.plugin(ghostPlugin)
  const remainder = plugin?.remainder
  if (!remainder) return false
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: remainder },
    selection: { anchor: pos + remainder.length },
    // One transaction, so a single undo takes the whole completion back.
    userEvent: 'input.complete',
  })
  return true
}

/// Tab and Right accept. Right as well as Tab because the caret is already at
/// the end of what's typed, so "move right" and "take the suggestion" are the
/// same gesture — and both fall through when no ghost is showing.
const ghostKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: acceptGhost },
    { key: 'ArrowRight', run: acceptGhost },
  ]),
)

export const editorCompletion = [ghostPlugin, ghostKeymap]

/// Exposed for tests only — the pure completion decision, without the focus
/// guard the on-screen plugin applies, so it can be exercised in a headless
/// editor that cannot take real focus.
export function ghostRemainderForTest(state: EditorState): string | null {
  return ghostRemainder(state)
}
