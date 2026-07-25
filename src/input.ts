//! Type-as-you-go transforms and emphasis commands.
//!
//! Port of the input handling in `MarkdownTextView.swift`. Everything here
//! resolves the instant a token completes and writes plain text — the saved
//! note contains an arrow, an emoji or an absolute date, never a special
//! syntax that needs rendering. That's the same reason the markdown is styled
//! rather than previewed: the file is the truth.

import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { Command, EditorView, KeyBinding } from '@codemirror/view'
import { EMOJI_SHORTCODES } from './emoji'
import { resolveDueToken } from './due'

/// A small, curated set of two-character sequences that expand into a single
/// arrow the instant the second character is typed.
///
/// Deliberately narrow: anything whose meaning is ambiguous outside code (like
/// `<=` — a left-double-arrow to some, "less than or equal" to anyone used to
/// comparisons) or that collides with existing markdown (`--`, which a
/// horizontal rule's `---` types straight through) is left out rather than
/// guessed at.
const LIGATURES: Record<string, string> = {
  '->': '→',
  '<-': '←',
  '=>': '⇒',
}

const EMOJI_RE = /:([a-zA-Z0-9_+\-]{1,32}):$/
/// A relative due token, anchored at the cursor — i.e. just completed.
const RELATIVE_DUE_RE =
  /(?<!\w)@(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i

const INLINE_CODE_RE = /`[^`\n]+`/g
const FENCED_CODE_RE = /^```[^\n]*\n[\s\S]*?\n```[ \t]*$/gm

function isInsideCode(text: string, pos: number): boolean {
  for (const re of [FENCED_CODE_RE, INLINE_CODE_RE]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      if (pos > m.index! && pos < m.index! + m[0].length) return true
    }
  }
  return false
}

/// Applies the three completion transforms after a change.
///
/// Implemented as a transaction filter rather than a keymap so it fires for
/// anything that inserts text — paste and IME included — and so each rewrite
/// lands in the *same* transaction as the keystroke that triggered it. That
/// last part is what makes undo behave: one Ctrl+Z takes back "`:smile:` became
/// 😄", rather than needing two, one of which restores an emoji.
export const completionTransforms = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(Transaction.remote)) return tr

  const doc = tr.newDoc
  const pos = tr.newSelection.main.head
  if (tr.newSelection.main.empty === false) return tr

  const before = doc.sliceString(Math.max(0, pos - 40), pos)

  // Emoji: ":smile:" → 😄. Checked first because its trigger character (a
  // colon) can't also be a ligature or a due token.
  const emoji = before.match(EMOJI_RE)
  if (emoji) {
    const replacement = EMOJI_SHORTCODES[emoji[1].toLowerCase()]
    if (replacement) {
      const from = pos - emoji[0].length
      return [
        tr,
        {
          changes: { from, to: pos, insert: replacement },
          selection: EditorSelection.cursor(from + replacement.length),
          // Same transaction as the keystroke, so undo is one step.
          sequential: true,
        },
      ]
    }
  }

  // Arrows: "->" → "→". Skipped inside code, where those characters are far
  // more likely to be an actual return-type arrow or a JSON path than
  // something meant to become a glyph.
  if (pos >= 2) {
    const pair = doc.sliceString(pos - 2, pos)
    const arrow = LIGATURES[pair]
    if (arrow && !isInsideCode(doc.toString(), pos)) {
      return [
        tr,
        {
          changes: { from: pos - 2, to: pos, insert: arrow },
          selection: EditorSelection.cursor(pos - 2 + arrow.length),
          sequential: true,
        },
      ]
    }
  }

  // Relative due tokens freeze to an absolute date the moment they complete.
  //
  // Without this, "@friday" means a different day every week — it would slide
  // forward forever and never go overdue. Written ISO because that form is
  // unambiguous and sorts correctly; the list still *displays* it as "Friday"
  // for the coming week.
  //
  // This can't loop: the replacement is an absolute date, which the relative
  // pattern can't match.
  const due = before.match(RELATIVE_DUE_RE)
  if (due) {
    const resolved = resolveDueToken(due[1])
    if (resolved) {
      const iso = `@${resolved.getFullYear()}-${String(resolved.getMonth() + 1).padStart(2, '0')}-${String(resolved.getDate()).padStart(2, '0')}`
      const from = pos - due[0].length
      return [
        tr,
        {
          changes: { from, to: pos, insert: iso },
          selection: EditorSelection.cursor(from + iso.length),
          sequential: true,
        },
      ]
    }
  }

  return tr
})

// --- Auto-pairing ------------------------------------------------------------

/// The closer each opener wraps a selection with.
const CLOSER_FOR_OPENER: Record<string, string> = {
  '[': ']',
  '(': ')',
  '`': '`',
  '*': '*',
  '~': '~',
}

/// Closers the editor manages, and therefore ones it will step over rather
/// than duplicate when typed against an identical character.
const MANAGED_CLOSERS = new Set([']', ')', '`', '*', '~'])

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)

/// What typing `text` at `[from, to)` should do, or null to let it through.
///
/// A pure function of the document rather than logic buried in a CodeMirror
/// callback — these rules have a lot of exceptions and each one deserves to be
/// checkable on its own, without a live editor to drive.
///
/// Driven by pattern-matching the text around the cursor rather than tracking
/// which characters were auto-inserted, so it stays correct even if the pair is
/// deleted or retyped by hand.
export type PairingEdit =
  /// A single replacement of `[from, to)`, with the resulting selection.
  | { kind: 'edit'; from: number; to: number; insert: string; selFrom: number; selTo: number }
  /// Step the cursor over a closer that's already there.
  | { kind: 'through'; cursor: number }

export function pairingEdit(
  doc: string,
  from: number,
  to: number,
  text: string,
): PairingEdit | null {
  const closer = CLOSER_FOR_OPENER[text]
  const at = (i: number) => (i >= 0 && i < doc.length ? doc[i] : '')

  // Typing a marker over a selection wraps it: select a word, press "[", get
  // "[word]".
  if (closer && from !== to) {
    return {
      kind: 'edit',
      from,
      to,
      insert: text + doc.slice(from, to) + closer,
      selFrom: from + text.length,
      selTo: to + text.length,
    }
  }
  if (from !== to) return null

  const after = at(to)
  const beforeChar = at(from - 1)

  // Typing a closer that's already sitting there steps over it rather than
  // adding a second one — otherwise closing a pair by hand doubles it.
  if (MANAGED_CLOSERS.has(text) && text === after) {
    return { kind: 'through', cursor: to + 1 }
  }
  if (!closer) return null

  const plain = (insert: string): PairingEdit => ({
    kind: 'edit',
    from,
    to,
    insert,
    selFrom: from + text.length,
    selTo: from + text.length,
  })

  /// The second character of a doubled opener — the "[" in "[[", the "~" in
  /// "~~" — needs a doubled closer, reconciled against whatever already
  /// follows: a complete pair is left alone, a lone closer is upgraded to a
  /// pair, and nothing there gets a fresh pair.
  const closeSecondOpener = (c: string): PairingEdit | null => {
    const doubled = c + c
    if (at(to) === c && at(to + 1) === c) return null
    if (at(to) === c) {
      // Replaces the single closer outright rather than inserting beside it —
      // inserting one more closer would be a single-character edit matching
      // the character already there, which the type-through rule above would
      // swallow entirely.
      return {
        kind: 'edit',
        from,
        to: to + 1,
        insert: text + doubled,
        selFrom: from + text.length,
        selTo: from + text.length,
      }
    }
    return plain(text + doubled)
  }

  // Nothing auto-closes directly before a word. Typing "[[" to the left of
  // "moon" would otherwise give "[[|]]moon", stranding the word outside the
  // link you were plainly making. Matches VS Code, Xcode and JetBrains.
  if (isWordChar(after)) return null

  // Nothing symmetric auto-closes directly *after* a word either. For "*", "`"
  // and "~" the same character opens and closes, so one typed right after a
  // word is finishing emphasis, not starting it — CommonMark says as much.
  // Looks past any run of the same delimiter already there, so the second "*"
  // of a closing "**" is judged against the "d" of "bold" rather than its own
  // first star.
  if (text === '*' || text === '`' || text === '~') {
    let i = from - 1
    while (i >= 0 && at(i) === text) i--
    if (isWordChar(at(i))) return null
  }

  switch (text) {
    case '`':
      // A third backtick completes a ```fence rather than opening a pair.
      if (beforeChar === '`' && at(from - 2) === '`') return null
      return plain('``')

    case '*': {
      // At the start of a line this is far more likely a bullet marker than
      // the start of *italic*.
      const lineStart = doc.lastIndexOf('\n', from - 1) + 1
      if (/^[ \t]*$/.test(doc.slice(lineStart, from))) return null
      // A third asterisk completes ***bold italic***, not a new pair.
      if (beforeChar === '*' && at(from - 2) === '*') return null
      return plain('**')
    }

    case '[':
      // A single "[" is valid on its own, for [text](url); a second one is
      // opening a wiki-link and wants "]]".
      return beforeChar === '[' ? closeSecondOpener(']') : plain('[]')

    case '~':
      // A single "~" has no meaning in Envy's markdown, so it's left alone
      // until a second one actually forms "~~".
      return beforeChar === '~' ? closeSecondOpener('~') : null

    case '(':
      // Only auto-closes right after "]", completing [text](…).
      return beforeChar === ']' ? plain('()') : null

    default:
      return null
  }
}

export const autoPairing = EditorView.inputHandler.of((view, from, to, text) => {
  const edit = pairingEdit(view.state.doc.toString(), from, to, text)
  if (!edit) return false
  if (edit.kind === 'through') {
    view.dispatch({ selection: EditorSelection.cursor(edit.cursor), userEvent: 'move' })
  } else {
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: EditorSelection.range(edit.selFrom, edit.selTo),
      userEvent: 'input.type',
    })
  }
  return true
})

// --- Due tokens --------------------------------------------------------------

const DUE_TOKEN_RE =
  /(?<![\w])@(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[0-9/-]+)(?!\w)/gi

/// The due token at `pos`, and whether it is *tightly* wrapped in its own
/// `~~@token~~`.
///
/// Tightly is deliberately narrower than "inside a strikethrough span" — which
/// is what `Note::active_due_dates` checks, so it also recognises a due date
/// crossed out as part of a longer struck sentence. A click can only
/// meaningfully remove a wrap it put there itself.
export function dueTokenAt(
  doc: string,
  pos: number,
): { from: number; to: number; crossedOut: boolean } | null {
  DUE_TOKEN_RE.lastIndex = 0
  for (const m of doc.matchAll(DUE_TOKEN_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (pos < from || pos > to) continue
    const crossedOut = doc.slice(from - 2, from) === '~~' && doc.slice(to, to + 2) === '~~'
    return { from, to, crossedOut }
  }
  return null
}

/// Clicking a due date retires it, or brings it back.
///
/// Wrapping in `~~` rather than deleting: the date is why the task mattered,
/// and a note should still say what was due even once it's done.
export function toggleDueToken(view: EditorView, pos: number): boolean {
  const doc = view.state.doc.toString()
  const token = dueTokenAt(doc, pos)
  if (!token) return false
  const text = doc.slice(token.from, token.to)
  if (token.crossedOut) {
    // Replaces the whole "~~@token~~" span in one edit rather than deleting
    // either side separately, so one undo takes it back.
    view.dispatch({
      changes: { from: token.from - 2, to: token.to + 2, insert: text },
      selection: EditorSelection.cursor(token.from - 2 + text.length),
    })
  } else {
    view.dispatch({
      changes: { from: token.from, to: token.to, insert: `~~${text}~~` },
      selection: EditorSelection.cursor(token.to + 4),
    })
  }
  return true
}

// --- Emphasis ----------------------------------------------------------------

/// Wraps the selection in `marker`, or unwraps it if it's already immediately
/// surrounded by one. A no-op with nothing selected, since there's no text to
/// apply emphasis to.
function toggleEmphasis(marker: string): Command {
  return (view) => {
    const { state } = view
    const sel = state.selection.main
    if (sel.empty) return false
    const doc = state.doc
    const len = marker.length

    // For "*", a single star only counts as an italic marker if it isn't half
    // of a "**" bold marker — otherwise toggling italic on bold text eats one
    // star off the pair.
    const isLoneStar = (at: number, checkingBefore: boolean) => {
      if (marker !== '*') return true
      const neighbour = checkingBefore ? at - 1 : at + len
      if (neighbour < 0 || neighbour >= doc.length) return true
      return doc.sliceString(neighbour, neighbour + 1) !== '*'
    }

    const beforeAt = sel.from - len
    const hasBefore =
      beforeAt >= 0 && doc.sliceString(beforeAt, sel.from) === marker && isLoneStar(beforeAt, true)
    const hasAfter =
      sel.to + len <= doc.length &&
      doc.sliceString(sel.to, sel.to + len) === marker &&
      isLoneStar(sel.to, false)

    if (hasBefore && hasAfter) {
      const inner = doc.sliceString(sel.from, sel.to)
      view.dispatch({
        changes: { from: beforeAt, to: sel.to + len, insert: inner },
        selection: EditorSelection.range(beforeAt, beforeAt + inner.length),
      })
      return true
    }

    const selected = doc.sliceString(sel.from, sel.to)
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: marker + selected + marker },
      selection: EditorSelection.range(sel.from + len, sel.to + len),
    })
    return true
  }
}

export const emphasisKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleEmphasis('**'), preventDefault: true },
  { key: 'Mod-i', run: toggleEmphasis('*'), preventDefault: true },
]
