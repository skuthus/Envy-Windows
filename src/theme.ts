// Skyler's "Envious" house palette, transcribed from Theme.swift.
// Roles are consistent across both faces (per the source comment):
//   blue   wiki-links, and the note list's selected row
//   red    the editor's text selection, and overdue
//   green  tags and ticked checkboxes
//   amber  due-soon, and search matches
//
// The dark greys are white at graded alpha (0.847 body, 0.549 secondary,
// 0.247 markers) rather than fixed RGB — opaque greys are only correct at one
// blur strength, and alpha keeps the hierarchy over whatever the window is
// actually letting through. Preserved here for the same reason: Mica/Acrylic
// on Win11 is exactly the same problem.

/// The Windows counterpart to the Mac theme's "SF Pro Text" default: the
/// system UI face, not a monospace one. Segoe UI Variable is Windows 11's;
/// Segoe UI is the Windows 10 fallback, and `system-ui` covers anything else.
///
/// Note text uses this. Code spans and fenced blocks deliberately do not — a
/// backtick means "this is literal", and proportional code is harder to read
/// for exactly the reasons monospace exists.
export const SYSTEM_UI_FONT =
  "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif"
export const MONO_FONT = "'Cascadia Code', 'Consolas', ui-monospace, monospace"

export interface EnvyTheme {
  /// Font is part of the theme on the Mac (`Theme.fontName` / `fontSize`) and
  /// applies to both faces — unlike colors, it isn't a light/dark concern.
  fontFamily: string
  fontSize: string
  text: string
  background: string
  marker: string
  link: string
  due: string
  dueSoon: string
  dueOverdue: string
  codeBackground: string
  tag: string
  tagBackground: string
  highlight: string
  /// Ink for text sitting on `highlight`.
  ///
  /// The Mac computes this at style time, flipping to black or white when the
  /// existing foreground would be unreadable over the highlight. CSS cannot
  /// measure contrast, so it becomes a paired token instead: one deliberate
  /// choice per theme rather than a calculation. Amber highlights want dark
  /// ink in both faces, which is why both values agree today — a theme with a
  /// dark highlight would set it differently.
  highlightText: string
  /// The note list's selection highlight.
  selection: string
  /// The editor's own text-selection background. A separate token from
  /// `selection` on purpose — they're different colors in Envious (blue for
  /// the list row, red for selected text).
  selectedText: string
  focusHighlight: string
  /// `fileListBackground` is its own token rather than reusing `background`
  /// because on the Mac a null value means "let the window's blur show
  /// through" — an absence, not a color. Same distinction will matter here
  /// once Mica/Acrylic is wired up.
  fileListBackground: string
  blockquote: string
  completedTask: string
  footnote: string
  checkedCheckbox: string
  titleBarBackground: string
}

export const enviousDark: EnvyTheme = {
  fontFamily: SYSTEM_UI_FONT,
  // 15px rather than the Mac's 13: Segoe UI has a smaller x-height than SF Pro
  // Text, so matching the number would read noticeably smaller than Envy does
  // on a Mac.
  fontSize: '15px',
  text: 'rgba(255, 255, 255, 0.847)',
  background: 'rgb(29, 30, 31)',
  marker: 'rgba(255, 255, 255, 0.247)',
  link: 'rgb(90, 128, 255)',
  due: 'rgb(255, 255, 255)',
  dueSoon: 'rgb(255, 188, 0)',
  dueOverdue: 'rgb(255, 75, 57)',
  codeBackground: 'rgb(55, 55, 55)',
  tag: 'rgb(52, 199, 89)',
  tagBackground: 'rgba(48, 209, 88, 0.153)',
  highlight: 'rgb(255, 188, 0)',
  highlightText: 'rgb(32, 29, 24)',
  selection: 'rgb(90, 128, 255)',
  selectedText: 'rgb(255, 75, 57)',
  focusHighlight: 'rgba(152, 168, 217, 0.25)',
  fileListBackground: 'rgb(29, 30, 31)',
  blockquote: 'rgba(255, 255, 255, 0.549)',
  completedTask: 'rgba(255, 255, 255, 0.549)',
  footnote: 'rgba(255, 255, 255, 0.549)',
  checkedCheckbox: 'rgb(52, 199, 89)',
  titleBarBackground: 'rgb(38, 38, 38)',
}

// Same roles, different hues. Every accent above was mixed for a near-black
// ground and three fail on paper — the blue and green lose contrast, the amber
// vanishes — so each is darkened until it clears. The two selections are the
// real departure: in dark they're opaque and the light body text reads against
// them; on paper, dark text on solid blue or red is unreadable, so both become
// tints.
export const enviousLight: EnvyTheme = {
  fontFamily: SYSTEM_UI_FONT,
  fontSize: '15px',
  text: 'rgba(0, 0, 0, 0.85)',
  background: 'rgb(250, 250, 248)',
  marker: 'rgba(0, 0, 0, 0.30)',
  link: 'rgb(27, 79, 216)',
  due: 'rgba(0, 0, 0, 0.85)',
  dueSoon: 'rgb(176, 124, 0)',
  dueOverdue: 'rgb(212, 42, 28)',
  codeBackground: 'rgb(240, 239, 234)',
  tag: 'rgb(23, 132, 58)',
  tagBackground: 'rgba(23, 132, 58, 0.13)',
  highlight: 'rgba(255, 188, 0, 0.55)',
  highlightText: 'rgb(32, 29, 24)',
  selection: 'rgba(27, 79, 216, 0.18)',
  selectedText: 'rgba(212, 42, 28, 0.22)',
  focusHighlight: 'rgba(96, 122, 176, 0.30)',
  fileListBackground: 'rgb(250, 250, 248)',
  blockquote: 'rgba(0, 0, 0, 0.55)',
  completedTask: 'rgba(0, 0, 0, 0.55)',
  footnote: 'rgba(0, 0, 0, 0.55)',
  checkedCheckbox: 'rgb(23, 132, 58)',
  titleBarBackground: 'rgb(240, 239, 234)',
}

export function applyTheme(theme: EnvyTheme) {
  const root = document.documentElement.style
  for (const [key, value] of Object.entries(theme)) {
    root.setProperty(`--envy-${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`, value)
  }
}
