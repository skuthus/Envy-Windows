# Envy for Windows

A Windows port of [Envy](https://github.com/skuthus/Envy) — a flat-file,
frictionless note-taking application. One search box, instant results, and
notes stored as plain `.md` files you can grep, sync, or edit with anything
else you like.

Built by [Skyler Schoos](https://github.com/skuthus). The macOS original is at
[envynote.app](https://envynote.app).

## Status

Early. Not yet usable, not yet released.

## Why this is a port and not a build target

The macOS app is Swift and SwiftUI. SwiftUI does not exist on Windows, so the
UI layer is a reimplementation rather than a recompilation. What *does* carry
over is the part that matters most: `Sources/EnvyCore` was written to be
platform-agnostic, and it ports to Rust close to mechanically.

The rule this repository follows: **behavior matches the macOS build exactly.**
Notes are plain files a person may well sync between the two, so a note that
means one thing on one platform and something else on the other is a data bug,
not a cosmetic difference. Where the macOS behavior is arguably wrong but
harmless, it is reproduced and documented rather than quietly corrected — see
`due::parse_flexible_date`.

## Structure

- `crates/envy-core` — the note model and store, ported from `EnvyCore`. No UI,
  no Tauri, no platform assumptions. `cargo test -p envy-core`.
- `src-tauri` — the Tauri v2 shell: windowing, tray, global hotkey, file
  dialogs, updater.
- `src` — the frontend. Live markdown styling is CodeMirror 6 decorations,
  which is the same shape as the macOS `MarkdownStyler`: ranged styling over a
  plain text buffer, with no separate preview mode.

## Stack

Tauri v2 (Rust + WebView2) with a TypeScript frontend. Chosen over Electron for
size and memory, and over WinUI 3 because a note app lives or dies by its text
editor and CodeMirror 6 is a far better starting point than building one.

## Requirements

- Rust (stable, `x86_64-pc-windows-msvc`)
- Node.js LTS
- MSVC C++ build tools + Windows SDK

## Not carried over from macOS

- **AeroSpace integration** — AeroSpace is a macOS tiling window manager with
  no Windows counterpart.
- **Apple Notes import** — no equivalent on Windows. The need it served
  (capture on a phone, file later) is real and will be met by a different
  importer.

## License

Proprietary. All rights reserved. Same terms as the macOS app: published for
source transparency, not intended to be built or packaged by anyone but its
maintainer.

## A Note on AI Usage

*Like the macOS app, this port is built with help from Claude Code.
Architecture, feature decisions, and design direction are the maintainer's.*
