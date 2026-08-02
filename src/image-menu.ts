//! The image attachment's right-click menu — size presets, open, rename, reveal
//! — shared by every window that renders images. Size and "Custom width…"
//! rewrite the marker in the given editor; rename is window-specific (its
//! reference-rewrite reloads the note differently in each window), so the flow
//! takes the window's own flush/reload hooks.

import { EditorView } from '@codemirror/view'
import { invoke } from '@tauri-apps/api/core'
import { buildImageMarker, type ImageEmbedSpec } from './styler'
import { openContextMenu } from './context-menu'
import { textPrompt, alertModal } from './prompt-modal'

/// Inserts `![[name]]` on its own line at the selection, with a leading break if
/// we're mid-line and a trailing blank line — the same shape the Mac's
/// `insertImageReference` uses (the blank line is where the picture sits).
export function insertImageReference(name: string, v: EditorView) {
  const sel = v.state.selection.main
  const atLineStart = sel.from === 0 || v.state.doc.sliceString(sel.from - 1, sel.from) === '\n'
  const insertion = `${atLineStart ? '' : '\n'}![[${name}]]\n\n`
  v.dispatch({
    changes: { from: sel.from, to: sel.to, insert: insertion },
    selection: { anchor: sel.from + insertion.length },
  })
  v.focus()
}

/// Replaces the first exact occurrence of an `![[…]]` marker in `view` with a
/// rewritten one — how the size menu changes an image's width. Keyed on the full
/// marker text rather than a stored position, so it stays correct after edits
/// above it.
export function rewriteEmbedMarker(view: EditorView, oldText: string, newText: string) {
  if (oldText === newText) return
  const at = view.state.doc.toString().indexOf(oldText)
  if (at === -1) return
  view.dispatch({ changes: { from: at, to: at + oldText.length, insert: newText } })
}

/// The prompt-and-rewrite half of renaming an attachment. The file move and the
/// vault-wide reference rewrite happen in Rust; `flush` puts the open buffer on
/// disk first (so its references are there to rewrite) and `reload` refreshes it
/// after (so it shows the new name rather than saving the old one back).
export async function renameAttachmentFlow(
  oldName: string,
  hooks: { flush: () => Promise<void>; reload: () => Promise<void> },
) {
  const input = await textPrompt('Rename image to:', oldName)
  if (input === null) return
  let next = input.trim()
  if (!next || next === oldName) return
  // Keep the extension if the user dropped it, so the reference stays an image.
  if (!next.includes('.')) {
    const dot = oldName.lastIndexOf('.')
    if (dot !== -1) next += oldName.slice(dot)
  }
  await hooks.flush()
  try {
    await invoke('rename_attachment', { oldName, newName: next })
  } catch (e) {
    await alertModal(typeof e === 'string' ? e : 'Could not rename the image.')
    return
  }
  await hooks.reload()
}

/// Opens the image menu at (x, y). `onRename` is the window's rename flow.
export function openImageMenu(
  raw: string,
  spec: ImageEmbedSpec,
  x: number,
  y: number,
  view: EditorView,
  onRename: (oldName: string) => void,
) {
  // Presets set the width and drop any explicit height, matching the Mac; the
  // caption rides along untouched. "Original size" clears the size token.
  const resize = (width: number | undefined) =>
    rewriteEmbedMarker(view, raw, buildImageMarker({ name: spec.name, width, caption: spec.caption }))
  openContextMenu(x, y, [
    { label: 'Small (240)', run: () => resize(240) },
    { label: 'Medium (400)', run: () => resize(400) },
    { label: 'Large (640)', run: () => resize(640) },
    { label: 'Original size', run: () => resize(undefined) },
    { label: '', separator: true },
    {
      label: 'Custom width…',
      run: async () => {
        const input = await textPrompt('Image width in pixels:', spec.width ? String(spec.width) : '')
        if (input === null) return
        const w = Math.round(Number(input))
        if (Number.isFinite(w) && w > 0) resize(w)
      },
    },
    { label: '', separator: true },
    { label: 'Open image', run: () => void invoke('open_attachment', { name: spec.name }) },
    { label: 'Rename…', run: () => onRename(spec.name) },
    {
      label: 'Reveal in Explorer',
      run: () => void invoke('reveal_attachment', { name: spec.name }),
    },
  ])
}
