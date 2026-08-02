//! The standard embed host — how an editor resolves `![[note]]` transclusions
//! and `![[image.png]]` attachments through Rust. The main window builds its own
//! (it also wires the image size/rename menu); the pop-out and pinned windows
//! use this factory, so all three resolve embeds the same way.

import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import type { EmbedHost, EmbedNote } from './styler'

interface NoteDto {
  id: string
  title: string
  content: string | null
}

/// An embed host backed by the Tauri commands. `currentNoteId` is the only
/// per-window difference (the self-embed guard). Editing a transcluded note
/// saves it and nudges the index so the change shows everywhere it's embedded.
///
/// `onImageContextMenu` is a no-op: the secondary windows have no context-menu
/// system, and the picture still opens on double-click, so right-clicking one
/// there simply does nothing.
export function makeEmbedHost(currentNoteId: () => string | null): EmbedHost {
  return {
    resolve: async (title): Promise<EmbedNote | null> => {
      const note = await invoke<NoteDto | null>('resolve_title', { title })
      return note && note.content !== null
        ? { id: note.id, title: note.title, content: note.content }
        : null
    },
    save: async (id, content) => {
      await invoke('save_note', { id, content })
      await emit('index-changed')
    },
    currentNoteId,
    readAttachment: (name) =>
      invoke<ArrayBuffer>('read_attachment', { name }).catch(() => null),
    openAttachment: (name) => void invoke('open_attachment', { name }),
    onImageContextMenu: () => {},
  }
}
