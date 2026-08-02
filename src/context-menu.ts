//! The app's own right-click menu. A webview has no access to a native menu, so
//! this reimplements the parts people expect for free: dismissal on click-away,
//! Escape, scroll, and window blur, plus flipping when it would open past the
//! window edge. Shared by every window (main, pop-out, pinned) so each has the
//! same menu — the module's listeners register per entry point.

const contextMenuEl = document.getElementById('context-menu')!

export interface MenuItemSpec {
  label: string
  /// Omitted for an item that only opens a submenu, and for a separator.
  run?: () => void | Promise<void>
  destructive?: boolean
  /// Turns this item into a submenu. Built lazily, on hover, because the only
  /// one so far lists the Index's folders and walking the disk to fill a menu
  /// nobody opened is work for nothing.
  submenu?: () => MenuItemSpec[] | Promise<MenuItemSpec[]>
  /// A horizontal rule rather than an item. The label is ignored.
  separator?: boolean
  /// A swatch drawn before the label — the colour of the folder an item files
  /// into, so the menu reads the same way the list does.
  swatch?: string | null
}

export function closeContextMenu() {
  contextMenuEl.classList.add('hidden')
  contextMenuEl.replaceChildren()
}

/// Builds the rows for one menu level. Shared by the menu and its submenus, so
/// a submenu looks and behaves like the menu it hangs off.
function menuRows(items: MenuItemSpec[], onPick: () => void): HTMLElement[] {
  return items.map((item) => {
    if (item.separator) {
      const hr = document.createElement('div')
      hr.className = 'context-separator'
      return hr
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'context-item' +
      (item.destructive ? ' destructive' : '') +
      (item.submenu ? ' has-submenu' : '')
    if (item.swatch !== undefined) {
      const dot = document.createElement('span')
      dot.className = 'context-swatch'
      // A folder with no colour still gets the slot, so labels line up.
      if (item.swatch) dot.style.background = item.swatch
      else dot.classList.add('empty')
      b.append(dot)
    }
    b.append(document.createTextNode(item.label))

    if (item.submenu) {
      const panel = document.createElement('div')
      panel.className = 'context-submenu hidden'
      b.append(panel)
      let filled = false
      b.onmouseenter = async () => {
        if (!filled) {
          filled = true
          panel.replaceChildren(...menuRows(await item.submenu!(), onPick))
        }
        panel.classList.remove('hidden')
        // Flip to the left when there isn't room on the right.
        const r = panel.getBoundingClientRect()
        panel.classList.toggle('flip', r.right > window.innerWidth)
      }
      b.onmouseleave = () => panel.classList.add('hidden')
      // A parent that only opens a submenu isn't itself clickable.
      if (!item.run) b.onclick = (e) => e.stopPropagation()
    }

    if (item.run) {
      b.onclick = () => {
        onPick()
        void item.run!()
      }
    }
    return b
  })
}

export function openContextMenu(x: number, y: number, items: MenuItemSpec[]) {
  contextMenuEl.replaceChildren(...menuRows(items, closeContextMenu))
  // Placed offscreen-but-measurable first: the size isn't known until the
  // items are in the DOM, and it's needed to decide whether to flip.
  contextMenuEl.classList.remove('hidden')
  contextMenuEl.style.left = '0px'
  contextMenuEl.style.top = '0px'
  const { width, height } = contextMenuEl.getBoundingClientRect()
  const left = x + width > window.innerWidth ? Math.max(0, x - width) : x
  const top = y + height > window.innerHeight ? Math.max(0, y - height) : y
  contextMenuEl.style.left = `${left}px`
  contextMenuEl.style.top = `${top}px`
}

// `capture` so a click that lands on something interactive closes the menu
// before that thing handles it, rather than after.
window.addEventListener(
  'mousedown',
  (e) => {
    if (!contextMenuEl.contains(e.target as Node)) closeContextMenu()
  },
  true,
)
window.addEventListener('blur', closeContextMenu)
window.addEventListener('scroll', closeContextMenu, true)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu()
})
// Suppress the webview's own menu everywhere — this is an app, not a page.
window.addEventListener('contextmenu', (e) => e.preventDefault())
