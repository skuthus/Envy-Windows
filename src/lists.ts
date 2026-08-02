//! List editing: Enter continues a bullet / numbered / task list (and an empty
//! item exits it), Tab/Shift-Tab nest a list line a level deeper or shallower,
//! and an ordered list renumbers itself as items are added, removed, or moved.
//!
//! Ported from the Mac's MarkdownTextView list handling and MarkdownStyler's
//! listContinuation. The three list regexes are the same the styler uses, with
//! the same capture groups: (indent/prefix)(marker)(content).

import { EditorView, keymap } from '@codemirror/view'
import { type ChangeSpec, type EditorState, Annotation, Prec } from '@codemirror/state'

/// A task item: an optional bullet prefix, the `[ ]`/`[x]` box, then content.
/// Group 1 is the whole prefix up to (and including) the box's leading space.
const TASK = /^(\s*(?:[-*+][ \t]+)?)(\[[ xX]\])([ \t]+.*)$/
/// A bullet item: (indent)(-|*|+)(content).
const UNORDERED = /^(\s*)([-*+])([ \t]+.*)$/
/// A numbered item: (indent)(digits then . or ))(content).
const ORDERED = /^(\s*)(\d+[.)])([ \t]+.*)$/
/// One nesting level, as spaces rather than a tab — more portable to whatever
/// other editor a plain-text note is opened in. Matches the Mac's listIndentUnit.
const INDENT_UNIT = '    '

/// Whether a line is any kind of list item — decides whether Tab/Shift-Tab nest
/// it instead of inserting a literal tab.
export function isListLine(line: string): boolean {
  return TASK.test(line) || UNORDERED.test(line) || ORDERED.test(line)
}

export type Continuation = { exit: true } | { marker: string } | null

/// What Return should do on this line: continue the list with a fresh marker
/// (the next number, for an ordered list), exit it (the current item is empty),
/// or nothing (not a list line). Mirrors MarkdownStyler.listContinuation.
export function listContinuation(line: string): Continuation {
  const empty = (s: string) => s.trim() === ''
  let m = TASK.exec(line)
  if (m) return empty(m[3]) ? { exit: true } : { marker: `${m[1]}[ ] ` }
  m = UNORDERED.exec(line)
  if (m) return empty(m[3]) ? { exit: true } : { marker: `${m[1]}${m[2]} ` }
  m = ORDERED.exec(line)
  if (m) {
    if (empty(m[3])) return { exit: true }
    const sep = m[2].endsWith(')') ? ')' : '.'
    const n = Number.parseInt(m[2].slice(0, -1), 10)
    if (Number.isNaN(n)) return null
    return { marker: `${m[1]}${n + 1}${sep} ` }
  }
  return null
}

/// The digits of a numbered line: their absolute range, the value, so the
/// renumber pass can replace just the number. Mirrors orderedListNumberInfo.
function orderedNumberInfo(
  line: string,
  lineStart: number,
): { from: number; length: number; number: number } | null {
  const m = ORDERED.exec(line)
  if (!m) return null
  const digits = m[2].slice(0, -1)
  const n = Number.parseInt(digits, 10)
  if (Number.isNaN(n)) return null
  return { from: lineStart + m[1].length, length: digits.length, number: n }
}

// A renumber transaction is tagged so its own change doesn't trigger another
// renumber pass — otherwise the listener would answer its own edit forever.
const renumberAnnotation = Annotation.define<boolean>()

function continueList(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const cont = listContinuation(line.text)
  if (!cont) return false
  if ('exit' in cont) {
    // Clear the empty item's marker, staying on the (now blank) line — the
    // next Return is an ordinary newline.
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, userEvent: 'input' })
  } else {
    const insert = '\n' + cont.marker
    view.dispatch({
      changes: { from: sel.head, insert },
      selection: { anchor: sel.head + insert.length },
      userEvent: 'input',
    })
  }
  return true
}

function indentListLine(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  if (!isListLine(line.text)) return false
  // Insert at the line start; CodeMirror maps the selection across it.
  view.dispatch({ changes: { from: line.from, insert: INDENT_UNIT }, userEvent: 'input' })
  return true
}

function outdentListLine(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  if (!isListLine(line.text)) return false
  const leading = /^[ \t]*/.exec(line.text)![0]
  // Already at the top level — still consume the key rather than let a literal
  // Shift-Tab fall through.
  if (leading.length === 0) return true
  const remove = Math.min(leading.length, INDENT_UNIT.length)
  view.dispatch({ changes: { from: line.from, to: line.from + remove, insert: '' }, userEvent: 'input' })
  return true
}

/// Renumbers the numbered-list block the cursor is in (or just above) so its
/// numbers run 1, 2, 3… from the first item's value, skipping only the number
/// the cursor is actively inside. Mirrors renumberOrderedListIfNeeded.
export function renumberEdits(state: EditorState): ChangeSpec[] {
  const { doc } = state
  const cursor = state.selection.main.head
  // Walk up while the line above is still an ordered item, so a block is found
  // even when the cursor has landed just below it after a deletion.
  let top = doc.lineAt(cursor)
  while (top.from > 0) {
    const prior = doc.lineAt(top.from - 1)
    if (!ORDERED.test(prior.text)) break
    top = prior
  }
  // Collect the consecutive ordered lines from there down.
  const lines: Array<{ from: number; text: string }> = []
  let line = top
  while (ORDERED.test(line.text)) {
    lines.push({ from: line.from, text: line.text })
    if (line.to + 1 > doc.length) break
    const next = doc.lineAt(line.to + 1)
    if (next.from === line.from) break
    line = next
  }
  const first = lines[0] && orderedNumberInfo(lines[0].text, lines[0].from)
  if (lines.length <= 1 || !first) return []

  let expected = first.number
  const edits: ChangeSpec[] = []
  for (const l of lines) {
    const info = orderedNumberInfo(l.text, l.from)
    if (info) {
      // Skip only when the cursor is inside the digits — someone typing "13"
      // over "1" shouldn't have it corrected mid-keystroke.
      const editingNumber = cursor > info.from && cursor <= info.from + info.length
      if (!editingNumber && info.number !== expected) {
        edits.push({ from: info.from, to: info.from + info.length, insert: String(expected) })
      }
    }
    expected++
  }
  return edits
}

// Renumber after any edit that wasn't itself a renumber — the equivalent of the
// Mac renumbering in didChangeText. Cheap when there's no list: the block walk
// bails immediately on a non-ordered line.
const renumberListener = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return
  // Only a user's own edit renumbers — never the programmatic content-set when
  // a note opens, which would silently rewrite a note's list and mark it dirty.
  const userEdit = update.transactions.some(
    (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'),
  )
  if (!userEdit) return
  if (update.transactions.some((tr) => tr.annotation(renumberAnnotation))) return
  const edits = renumberEdits(update.state)
  if (edits.length === 0) return
  update.view.dispatch({
    changes: edits,
    annotations: renumberAnnotation.of(true),
    userEvent: 'input.renumber',
  })
})

/// The whole list-editing layer. `Prec.high` so Enter/Tab/Shift-Tab beat the
/// default keymap's newline/indent — but still below the ghost-completion
/// keymap (Prec.highest), which accepts a suggestion on Tab first.
export const listEditing = [
  Prec.high(
    keymap.of([
      { key: 'Enter', run: continueList },
      { key: 'Tab', run: indentListLine },
      { key: 'Shift-Tab', run: outdentListLine },
    ]),
  ),
  renumberListener,
]
