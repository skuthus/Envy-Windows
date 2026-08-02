//! The Insert Image picker — a grid of every image already in the vault, so one
//! can be re-inserted by sight rather than by remembering a name like "Pasted
//! image 3.png". Mirrors the Mac's ImageAttachmentPicker. Shared by every window
//! that lets you insert an image; the caller passes what to do with the pick (drop
//! `![[name]]` into that window's editor) and guards on whether a note is open.

import { invoke } from '@tauri-apps/api/core'

const pickerEl = document.getElementById('image-picker')!
const filterEl = document.getElementById('image-picker-filter') as HTMLInputElement
const gridEl = document.getElementById('image-picker-grid')!
const emptyEl = document.getElementById('image-picker-empty')!
let names: string[] = []
let urls: string[] = []
// Filtering rebuilds the grid; a bumped generation makes a slow thumbnail load
// from a superseded build (or after close) drop its result instead of leaking.
let gen = 0
let onPick: (name: string) => void = () => {}

export async function openImagePicker(pick: (name: string) => void) {
  onPick = pick
  names = await invoke<string[]>('list_image_attachments')
  filterEl.value = ''
  buildGrid('')
  pickerEl.classList.remove('hidden')
  filterEl.focus()
}

function closeImagePicker() {
  if (pickerEl.classList.contains('hidden')) return
  gen++
  pickerEl.classList.add('hidden')
  gridEl.replaceChildren()
  for (const url of urls) URL.revokeObjectURL(url)
  urls = []
}

function matches(filter: string): string[] {
  const needle = filter.trim().toLowerCase()
  return needle ? names.filter((n) => n.toLowerCase().includes(needle)) : names
}

function buildGrid(filter: string) {
  const build = ++gen
  for (const url of urls) URL.revokeObjectURL(url)
  urls = []
  gridEl.replaceChildren()
  const found = matches(filter)
  if (found.length === 0) {
    emptyEl.textContent =
      names.length === 0
        ? 'No images yet. Drag or paste a picture into a note first.'
        : 'No matches.'
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')
  for (const name of found) {
    const cell = document.createElement('button')
    cell.type = 'button'
    cell.className = 'image-picker-cell'
    const thumb = document.createElement('div')
    thumb.className = 'thumb'
    const img = document.createElement('img')
    img.alt = name
    img.loading = 'lazy'
    thumb.append(img)
    const label = document.createElement('div')
    label.className = 'name'
    label.textContent = name
    cell.append(thumb, label)
    cell.addEventListener('click', () => pick(name))
    gridEl.append(cell)
    void invoke<ArrayBuffer>('read_attachment', { name })
      .then((bytes) => {
        if (build !== gen) return // superseded build or closed
        const url = URL.createObjectURL(new Blob([bytes]))
        urls.push(url)
        img.src = url
      })
      .catch(() => {
        /* a missing file just shows an empty thumb */
      })
  }
}

function pick(name: string) {
  closeImagePicker()
  onPick(name)
}

filterEl.addEventListener('input', () => buildGrid(filterEl.value))
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // Return inserts the first match — the quick path when you half-remember the
    // name; otherwise click a thumbnail.
    e.preventDefault()
    const first = matches(filterEl.value)[0]
    if (first) pick(first)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeImagePicker()
  }
})
pickerEl.addEventListener('click', (e) => {
  if (e.target === pickerEl) closeImagePicker() // click the backdrop to dismiss
})
