//! Stand-ins for window.prompt / window.confirm / window.alert, none of which
//! work in Tauri's WebView2 — prompt returns null without ever showing, and
//! confirm/alert are suppressed too, so a rename would silently do nothing. These
//! drive an in-app modal instead and read like the browser APIs they replace:
//! `await textPrompt(...)` resolves to the trimmed text or null; `await
//! confirmModal(...)` resolves to a boolean. Shared by every window.

const promptEl = document.getElementById('prompt')!
const promptMessageEl = document.getElementById('prompt-message')!
const promptInputEl = document.getElementById('prompt-input') as HTMLInputElement
const promptFormEl = document.getElementById('prompt-panel') as HTMLFormElement
const promptOkEl = document.getElementById('prompt-ok') as HTMLButtonElement
const promptCancelEl = document.getElementById('prompt-cancel') as HTMLButtonElement
// null means cancelled; a string (possibly empty) means confirmed — so the
// confirm variant, which has no text field, still distinguishes OK from Cancel.
let promptResolve: ((value: string | null) => void) | null = null

// Where focus lands after a dialog closes differs per window (the main window's
// search box, an editor elsewhere), so each entry point sets it once.
let focusReturn: () => void = () => {}
export function setPromptFocusReturn(fn: () => void) {
  focusReturn = fn
}

/// Whether a dialog is currently up — for callers that suppress their own
/// keyboard handling while the modal owns the screen.
export function isDialogOpen(): boolean {
  return promptResolve !== null
}

function closePrompt(value: string | null) {
  if (!promptResolve) return
  const resolve = promptResolve
  promptResolve = null
  promptEl.classList.add('hidden')
  focusReturn()
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

export function textPrompt(message: string, initial = ''): Promise<string | null> {
  return openDialog(message, initial, 'OK', 'Cancel')
}

/// A yes/no confirm. Resolves true only when OK is chosen; Cancel, Escape and a
/// backdrop click all resolve false — the safe default for a destructive step.
export function confirmModal(message: string, okLabel = 'OK'): Promise<boolean> {
  return openDialog(message, null, okLabel, 'Cancel').then((v) => v !== null)
}

/// A message with a single dismiss button — the window.alert replacement.
export function alertModal(message: string): Promise<void> {
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
