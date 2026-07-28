//! The reference surfaces: Markup, Shortcuts, Emoji, About.
//!
//! On the Mac these are separate windows reached from the menu bar. Windows
//! has no menu bar here, so they share one overlay with tabs — the same
//! content, one way in, and nothing permanently occupying the window.

import markupGroups from './markup-help.json'
import { EMOJI_SHORTCODES } from './emoji'
// The application icon itself, not a copy or a redrawing of it. About is where
// someone looks to confirm what they are running, so showing anything other
// than the real mark is the one place it actually matters.
import appIcon from '../src-tauri/icons/128x128@2x.png'

interface MarkupEntry {
  syntax: string
  description: string
}
interface MarkupGroup {
  title: string
  entries: MarkupEntry[]
}

/// The Mac's descriptions name Mac keys. Rewriting them here rather than
/// editing the extracted data keeps the port mechanical — re-extracting from
/// the Swift stays a one-command job.
function windowsKeys(text: string): string {
  return text
    .replace(/\bCmd\+/g, 'Ctrl+')
    .replace(/\bCommand-/g, 'Ctrl-')
    .replace(/\bOption-/g, 'Alt-')
    .replace(/\bOption\+/g, 'Alt+')
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
}

/// Every shortcut the app binds, as the single source for this sheet.
///
/// Listed here rather than derived from the handlers because the handlers are
/// spread across three files and a keyboard reference that silently drifts
/// from the bindings is worse than none.
export const SHORTCUTS: Array<{ group: string; items: Array<[string, string]> }> = [
  {
    group: 'Anywhere',
    items: [
      ['Ctrl+Alt+Enter', 'Show or hide Envy'],
      ['Ctrl+Alt+Down', 'Show or hide the pinned note'],
      ['Ctrl+Alt+Shift+P', 'Unpin the note pinned to the tray'],
    ],
  },
  {
    group: 'Searching',
    items: [
      ['Ctrl+L', 'Jump to the search box'],
      ['Up / Down', 'Move the highlighted note'],
      ['Shift+Up / Shift+Down', 'Extend the selection'],
      ['Return', 'Open the top match, or create a note from what you typed'],
      ['Alt+Backspace', 'Clear the search box'],
      ['Escape', 'Clear the search box'],
    ],
  },
  {
    group: 'Notes',
    items: [
      ['Ctrl+Backspace', 'Move the selection to trash'],
      ['Ctrl+Shift+Backspace', 'Restore the last deleted note(s)'],
      ['Ctrl+Alt+P', 'Pin or unpin at the top of the list'],
      ['Ctrl+Alt+T', 'Pin the highlighted note to the tray'],
      ['Ctrl-click a [[link]]', 'Open it, creating it if needed'],
      ['Alt-click a [[link]]', 'Preview it without leaving'],
      ['Click a due date', 'Retire it, or bring it back'],
    ],
  },
  {
    group: 'Editing',
    items: [
      ['Ctrl+B / Ctrl+I', 'Bold or italicise the selection'],
      ['Ctrl+= / Ctrl+- / Ctrl+0', 'Zoom the note text in, out, or reset'],
      ['Ctrl+Shift+P', 'Toggle plain-text mode'],
      ['Alt+Up', 'Move focus from the editor back to search'],
    ],
  },
  {
    group: 'Window',
    items: [
      ['Ctrl+Shift+L', 'Toggle vertical / horizontal layout'],
      ['Ctrl+Shift+B', 'Toggle the interlinks panel'],
      ['Ctrl+Enter', 'Centre the window'],
      ['Ctrl+,', 'Settings'],
    ],
  },
]

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderMarkup(): HTMLElement {
  const root = el('div', 'reference-body')
  for (const group of markupGroups as MarkupGroup[]) {
    root.append(el('h4', 'reference-group', group.title))
    const table = el('div', 'reference-table')
    for (const entry of group.entries) {
      table.append(el('code', 'reference-syntax', entry.syntax))
      table.append(el('div', 'reference-desc', windowsKeys(entry.description)))
    }
    root.append(table)
  }
  return root
}

function renderShortcuts(): HTMLElement {
  const root = el('div', 'reference-body')
  for (const group of SHORTCUTS) {
    root.append(el('h4', 'reference-group', group.group))
    const table = el('div', 'reference-table')
    for (const [keys, what] of group.items) {
      table.append(el('code', 'reference-syntax', keys))
      table.append(el('div', 'reference-desc', what))
    }
    root.append(table)
  }
  return root
}

function renderEmoji(): HTMLElement {
  const root = el('div', 'reference-body')
  root.append(
    el(
      'p',
      'reference-desc',
      'Type a shortcode and finish it with the closing colon — it is replaced with the emoji immediately.',
    ),
  )
  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'reference-search'
  search.placeholder = 'Filter shortcodes'
  root.append(search)

  const grid = el('div', 'emoji-grid')
  const entries = Object.entries(EMOJI_SHORTCODES)
  const draw = (filter: string) => {
    const needle = filter.trim().toLowerCase()
    const matches = needle ? entries.filter(([code]) => code.includes(needle)) : entries
    grid.replaceChildren(
      ...(matches.length === 0
        ? [el('div', 'reference-desc', `No shortcodes match “${filter}”.`)]
        : matches.map(([code, emoji]) => {
            const cell = el('div', 'emoji-cell')
            cell.append(el('span', 'emoji-glyph', emoji), el('code', '', `:${code}:`))
            // Clicking copies, since the point of browsing is to then use one.
            cell.title = 'Copy'
            cell.onclick = () => void navigator.clipboard?.writeText(`:${code}:`)
            return cell
          })),
    )
  }
  search.oninput = () => draw(search.value)
  draw('')
  root.append(grid)
  return root
}

function renderAbout(version: string): HTMLElement {
  const root = el('div', 'reference-body about')
  const mark = document.createElement('img')
  mark.className = 'about-mark'
  mark.src = appIcon
  mark.alt = 'Envy'
  mark.width = 88
  mark.height = 88
  root.append(mark)
  root.append(el('h3', '', 'Envy for Windows'))
  root.append(el('p', 'reference-desc', 'A flat-file, frictionless note-taking application.'))
  root.append(el('p', 'reference-desc', `Version ${version}`))
  root.append(el('p', 'reference-desc', 'Made by Skyler Schoos'))
  root.append(el('p', 'reference-desc', '© 2026'))
  return root
}

/// What changed in this build.
///
/// The Windows port's own history rather than a copy of the Mac's changelog —
/// the two apps have different pasts, and showing macOS release notes to a
/// Windows user would be describing changes they never experienced.
const WHATS_NEW: Array<{ title: string; body: string }> = [
  {
    title: 'Updates actually apply now',
    body: 'An update could report success while leaving the old version in place, so Envy would offer you the same update on every launch. It was installing over its own running copy and quietly skipping the file it could not replace. It now steps out of the way first.',
  },
  {
    title: 'Colour your folders',
    body: 'Organise by pile, if you like — a second axis alongside tags. Turn on “Show items in subfolders” in Settings, give a folder a colour, and every note inside it shows a dot in that colour. Right-click a note → Move to → to file it, or make a folder on the spot. It is a real file move, so the title does not change and [[links]] still resolve.',
  },
  {
    title: 'Tags got colour too',
    body: 'Right-click a tag chip beside a note’s title to colour that tag, and every note carrying it shows the same colour. Like a folder’s colour it is a preference, never written into a note — your #tag on disk is untouched.',
  },
  {
    title: 'Split a note in two',
    body: 'When a note has quietly grown to hold two ideas, select the part that wants to stand alone and press Ctrl+Alt+N. It becomes its own note, with a [[link]] left in its place and the title taken from the selection’s first line.',
  },
  {
    title: 'Highlighting, and a stale: search',
    body: '==highlight== marks text with a background. And stale: is the flip side of date: — notes you have not touched. Bare stale: means the last six months; stale:week, stale:month, stale:year or stale:90 narrow it. Pair it with orphan: to surface notes that are both disconnected and forgotten.',
  },
  {
    title: 'Cleaner links',
    body: 'A bare URL collapses to a tidy pill showing just its domain, and right-clicking one lets you give that site an emoji. Click into it and the full address comes back so you can edit it.',
  },
]

export type ReferenceTab = 'markup' | 'shortcuts' | 'emoji' | 'whatsnew' | 'about'

export function renderReference(tab: ReferenceTab, version: string): HTMLElement {
  switch (tab) {
    case 'shortcuts':
      return renderShortcuts()
    case 'emoji':
      return renderEmoji()
    case 'whatsnew': {
      const root = el('div', 'reference-body')
      for (const item of WHATS_NEW) {
        root.append(el('h4', 'reference-group', item.title))
        root.append(el('p', 'reference-desc', item.body))
      }
      return root
    }
    case 'about':
      return renderAbout(version)
    default:
      return renderMarkup()
  }
}
