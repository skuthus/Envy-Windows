//! Remappable keyboard shortcuts.
//!
//! Every binding the app reacts to is declared here, so there is one list to
//! read, one to remap, and one for the reference sheet to show. Handlers ask
//! `matches()` rather than testing keys themselves — a handler that checks
//! `e.key === 'l'` directly is a binding nobody can change and nobody can find.

export type ShortcutId =
  | 'jumpToSearch'
  | 'newFromTemplate'
  | 'extractToNote'
  | 'deleteNote'
  | 'restoreDeletedNote'
  | 'toggleLayout'
  | 'bold'
  | 'italic'
  | 'zoomIn'
  | 'zoomOut'
  | 'actualSize'
  | 'centerWindow'
  | 'togglePlainTextMode'
  | 'focusNextArea'
  | 'focusPreviousArea'
  | 'togglePin'
  | 'pinToTray'
  | 'toggleInterlinks'
  | 'openSettings'
  | 'clearSearch'
  | 'summonApp'
  | 'showPinnedNote'
  | 'unpinFromTray'

export interface ShortcutSpec {
  id: ShortcutId
  label: string
  /// The default binding, in the same string form remaps are stored as.
  default: string
  /// Global shortcuts are registered with the OS and work from any app, so
  /// changing one has to go back to Rust rather than just updating a table.
  global?: boolean
  /// Handled inside CodeMirror rather than by the window handler, so changing
  /// one reconfigures the editor's keymap.
  editor?: boolean
}

export const SHORTCUT_SPECS: ShortcutSpec[] = [
  { id: 'summonApp', label: 'Show/Hide Envy (works from any app)', default: 'Ctrl+Alt+Enter', global: true },
  { id: 'showPinnedNote', label: 'Show/Hide Pinned Note (works from any app)', default: 'Ctrl+Alt+ArrowDown', global: true },
  { id: 'unpinFromTray', label: 'Unpin Note from Tray (works from any app)', default: 'Ctrl+Alt+Shift+P', global: true },
  { id: 'jumpToSearch', label: 'Jump to Search', default: 'Ctrl+L' },
  { id: 'clearSearch', label: 'Clear Search', default: 'Alt+Backspace' },
  { id: 'newFromTemplate', label: 'New Note from Template', default: 'Ctrl+Shift+N' },
  // The Mac's ⌥⌘N. It makes a note, so it sits beside the other "new"
  // shortcuts rather than the formatting ones.
  { id: 'extractToNote', label: 'Extract Selection to New Note', default: 'Ctrl+Alt+N', editor: true },
  { id: 'deleteNote', label: 'Delete Note', default: 'Ctrl+Backspace' },
  { id: 'restoreDeletedNote', label: 'Restore Deleted Note', default: 'Ctrl+Shift+Backspace' },
  { id: 'togglePin', label: 'Pin/Unpin Note', default: 'Ctrl+Alt+P' },
  { id: 'pinToTray', label: 'Pin Note to Tray', default: 'Ctrl+Alt+T' },
  { id: 'toggleLayout', label: 'Toggle Layout', default: 'Ctrl+Shift+L' },
  { id: 'toggleInterlinks', label: 'Toggle Interlinks', default: 'Ctrl+Shift+B' },
  { id: 'togglePlainTextMode', label: 'Toggle Plain-Text Mode', default: 'Ctrl+Shift+P' },
  { id: 'centerWindow', label: 'Centre Window', default: 'Ctrl+Enter' },
  { id: 'openSettings', label: 'Settings', default: 'Ctrl+,' },
  { id: 'focusNextArea', label: 'Focus Next Area', default: 'Alt+ArrowDown' },
  { id: 'focusPreviousArea', label: 'Focus Previous Area', default: 'Alt+ArrowUp' },
  { id: 'bold', label: 'Bold', default: 'Ctrl+B', editor: true },
  { id: 'italic', label: 'Italic', default: 'Ctrl+I', editor: true },
  { id: 'zoomIn', label: 'Zoom In', default: 'Ctrl+=' },
  { id: 'zoomOut', label: 'Zoom Out', default: 'Ctrl+-' },
  { id: 'actualSize', label: 'Actual Size', default: 'Ctrl+0' },
]

const STORAGE_KEY = 'customShortcuts'

function loadOverrides(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

let overrides = loadOverrides()

export function bindingFor(id: ShortcutId): string {
  const spec = SHORTCUT_SPECS.find((s) => s.id === id)
  return overrides[id] ?? spec?.default ?? ''
}

export function setBinding(id: ShortcutId, binding: string | null) {
  if (binding) overrides[id] = binding
  else delete overrides[id]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

export function resetAllBindings() {
  overrides = {}
  localStorage.removeItem(STORAGE_KEY)
}

/// Canonical form of a keyboard event, so a binding compares as a string.
///
/// Modifier order is fixed rather than however they were pressed — otherwise
/// "Alt+Ctrl+P" and "Ctrl+Alt+P" would be different bindings that behave
/// identically, and only one of them would ever match.
export function eventToBinding(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key = e.key
  if (key === ' ') key = 'Space'
  // Single letters normalise to upper case so Shift doesn't change identity.
  else if (key.length === 1) key = key.toUpperCase()
  parts.push(key)
  return parts.join('+')
}

/// Whether an event is a bare modifier press. A recorder has to ignore these
/// or it captures "Ctrl" the instant you reach for a chord.
export function isModifierOnly(e: KeyboardEvent): boolean {
  return ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)
}

export function matches(id: ShortcutId, e: KeyboardEvent): boolean {
  return eventToBinding(e) === bindingFor(id)
}

/// Human-readable form for the reference sheet and the recorder.
export function displayBinding(binding: string): string {
  return binding
    .replace('ArrowDown', 'Down')
    .replace('ArrowUp', 'Up')
    .replace('ArrowLeft', 'Left')
    .replace('ArrowRight', 'Right')
}

/// Any binding used by more than one action. A clash means one of them can
/// never fire, and silently losing a shortcut is worse than being told.
export function conflicts(): Map<string, ShortcutId[]> {
  const byBinding = new Map<string, ShortcutId[]>()
  for (const spec of SHORTCUT_SPECS) {
    const b = bindingFor(spec.id)
    if (!b) continue
    byBinding.set(b, [...(byBinding.get(b) ?? []), spec.id])
  }
  for (const [b, ids] of byBinding) if (ids.length < 2) byBinding.delete(b)
  return byBinding
}

/// The three global bindings, in the form the Rust side registers them.
export function globalBindings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of SHORTCUT_SPECS) {
    if (spec.global) out[spec.id] = bindingFor(spec.id)
  }
  return out
}
