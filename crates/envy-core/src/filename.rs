//! Turning a note title into a filename.
//!
//! **This is the one place the Windows port cannot match macOS exactly, and
//! the divergence is worth understanding before changing anything here.**
//!
//! A note's title *is* its filename — there is no separately stored title. So
//! the set of legal filenames is the set of legal titles, and Windows' set is
//! strictly smaller than macOS':
//!
//! | | forbidden in a filename |
//! |---|---|
//! | macOS (APFS) | `/` (and `:`, for Finder's benefit) |
//! | Windows (NTFS) | `< > : " / \ | ? *`, control chars, trailing `.` or space, and the reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) |
//!
//! `NoteStore.uniqueFilename` on the Mac replaces `/` and `:` with `-`. That
//! is not enough here: a note titled `Q3: Results?` is a perfectly ordinary
//! file on macOS (`Q3- Results?.md`) and simply cannot exist on Windows.
//!
//! The consequence, which is a product question rather than a technical one:
//! a note created on macOS with `?`, `*`, `"`, `<`, `>`, `|`, or `\` in its
//! title **cannot round-trip**. Syncing an Index between the two platforms
//! will rename such a note on arrival here, and any `[[wiki-link]]` pointing
//! at its old title stops resolving. The same substitution character (`-`) is
//! used as the Mac's, so the result at least *looks* like something Envy
//! produced rather than a mangled string.
//!
//! Nothing in this module tries to be clever about that — it sanitizes, and
//! the mismatch is documented rather than hidden.

use std::path::{Path, PathBuf};

/// Characters NTFS rejects outright, plus the two the Mac already replaces.
const ILLEGAL: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Reserved DOS device names. Still special-cased by Win32 after four decades:
/// a file called `CON.md` cannot be created, and the check is case-insensitive
/// and ignores the extension.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Makes `title` safe to use as a Windows filename stem.
///
/// Mirrors `NoteStore.uniqueFilename`'s choice of `-` as the replacement so a
/// sanitized name reads like the Mac's would, then handles the cases Windows
/// adds on top. An empty result becomes "Untitled", matching the Mac.
pub fn sanitize_title(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| {
            if ILLEGAL.contains(&c) || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();

    // Windows silently strips trailing dots and spaces from filenames, which
    // would make "Notes..." and "Notes" the same file — and worse, make a
    // rename between them look like a no-op. Trim them off explicitly so the
    // name we choose is the name we get.
    s = s.trim().trim_end_matches(['.', ' ']).trim().to_string();

    if s.is_empty() {
        return "Untitled".to_string();
    }

    // A reserved device name is rejected whatever the extension, so "CON.md"
    // fails as surely as "CON". Suffixing with "_" keeps the title readable
    // and can't collide with the reserved set.
    let stem_upper = s.to_uppercase();
    if RESERVED.contains(&stem_upper.as_str()) {
        s.push('_');
    }

    s
}

/// A free filename in `directory` for an attachment, **preserving the original
/// extension** and disambiguating the base with " (2)", " (3)"… — the shape the
/// Mac's `availableAttachmentName` uses. The base is sanitized the same way a
/// title is, but falls back to "attachment" rather than "Untitled"; the
/// extension keeps it clear of the reserved-device-name case a bare stem hits.
pub fn available_attachment_name(filename: &str, directory: &Path) -> String {
    let (raw_base, ext) = match filename.rsplit_once('.') {
        Some((b, e)) if !b.is_empty() && !e.is_empty() => (b, Some(e)),
        _ => (filename, None),
    };
    let mut base: String = raw_base
        .chars()
        .map(|c| if ILLEGAL.contains(&c) || c.is_control() { '-' } else { c })
        .collect();
    base = base.trim().trim_end_matches(['.', ' ']).trim().to_string();
    if base.is_empty() {
        base = "attachment".to_string();
    }
    let with = |b: &str| match ext {
        Some(e) => format!("{b}.{e}"),
        None => b.to_string(),
    };
    let mut candidate = with(&base);
    let mut counter = 2;
    while directory.join(&candidate).exists() {
        candidate = with(&format!("{base} ({counter})"));
        counter += 1;
    }
    candidate
}

/// A free filename in `directory` for `title`, disambiguating with " 2",
/// " 3"… — the shape `NoteStore.uniqueFilename` uses.
pub fn unique_filename(title: &str, directory: &Path) -> String {
    let base = sanitize_title(title);
    let mut candidate = format!("{base}.md");
    let mut suffix = 2;
    while directory.join(&candidate).exists() {
        candidate = format!("{base} {suffix}.md");
        suffix += 1;
    }
    candidate
}

/// A free path in `directory` for `title`, disambiguating with " (2)", " (3)"…
///
/// Parenthesised rather than a bare " 2", which reads as part of a title — a
/// note actually called "Ideas 2" is entirely plausible. Compared
/// case-insensitively because NTFS is (like APFS): "ideas" and "Ideas" already
/// collide at the filesystem level, so matching only exact case would happily
/// generate a name the OS then refuses.
///
/// Deliberately a separate function from `unique_filename` with a different
/// disambiguation shape, because the Mac has both and uses each in different
/// places — matching that rather than unifying them keeps filenames identical
/// across platforms for the same action.
pub fn available_path(title: &str, directory: &Path) -> PathBuf {
    let existing: Vec<String> = std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    Path::new(&e.file_name())
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_lowercase())
                })
                .collect()
        })
        .unwrap_or_default();

    let base = sanitize_title(title);
    if !existing.contains(&base.to_lowercase()) {
        return directory.join(format!("{base}.md"));
    }
    let mut counter = 2;
    while existing.contains(&format!("{base} ({counter})").to_lowercase()) {
        counter += 1;
    }
    directory.join(format!("{base} ({counter}).md"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_same_characters_the_mac_does() {
        assert_eq!(sanitize_title("a/b"), "a-b");
        assert_eq!(sanitize_title("Q3: Results"), "Q3- Results");
    }

    /// The characters macOS allows and Windows does not. Each of these is a
    /// title that exists happily on the Mac side and must be rewritten here.
    #[test]
    fn replaces_the_characters_only_windows_forbids() {
        assert_eq!(sanitize_title("What?"), "What-");
        assert_eq!(sanitize_title("a*b"), "a-b");
        assert_eq!(sanitize_title(r#"say "hi""#), "say -hi-");
        assert_eq!(sanitize_title("a<b>c"), "a-b-c");
        assert_eq!(sanitize_title(r"path\to"), "path-to");
        assert_eq!(sanitize_title("a|b"), "a-b");
    }

    #[test]
    fn strips_trailing_dots_and_spaces() {
        // Windows would strip these itself, making "Notes..." and "Notes" the
        // same file — and a rename between them a confusing no-op.
        assert_eq!(sanitize_title("Notes..."), "Notes");
        assert_eq!(sanitize_title("Notes   "), "Notes");
        assert_eq!(sanitize_title("  Notes  "), "Notes");
    }

    #[test]
    fn suffixes_reserved_device_names() {
        assert_eq!(sanitize_title("CON"), "CON_");
        assert_eq!(sanitize_title("con"), "con_");
        assert_eq!(sanitize_title("COM1"), "COM1_");
        assert_eq!(sanitize_title("LPT9"), "LPT9_");
        // Not reserved — only the exact names are.
        assert_eq!(sanitize_title("CONTEXT"), "CONTEXT");
        assert_eq!(sanitize_title("COM10"), "COM10");
    }

    #[test]
    fn empty_becomes_untitled() {
        assert_eq!(sanitize_title(""), "Untitled");
        assert_eq!(sanitize_title("   "), "Untitled");
    }

    /// A title made entirely of illegal characters substitutes down to dashes
    /// rather than falling back to "Untitled" — the Mac replaces first and
    /// only then checks for emptiness, so it produces "---" here too. Odd
    /// looking, but matching it matters more than tidying it.
    #[test]
    fn all_illegal_characters_substitute_rather_than_falling_back() {
        assert_eq!(sanitize_title("///"), "---");
        assert_eq!(sanitize_title("???"), "---");
    }

    #[test]
    fn control_characters_are_replaced() {
        assert_eq!(sanitize_title("a\u{0}b"), "a-b");
        assert_eq!(sanitize_title("a\tb"), "a-b");
    }

    #[test]
    fn unique_filename_disambiguates_with_a_bare_number() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unique_filename("Ideas", dir.path()), "Ideas.md");
        std::fs::write(dir.path().join("Ideas.md"), "").unwrap();
        assert_eq!(unique_filename("Ideas", dir.path()), "Ideas 2.md");
        std::fs::write(dir.path().join("Ideas 2.md"), "").unwrap();
        assert_eq!(unique_filename("Ideas", dir.path()), "Ideas 3.md");
    }

    #[test]
    fn available_path_disambiguates_with_parentheses() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(available_path("Ideas", dir.path()), dir.path().join("Ideas.md"));
        std::fs::write(dir.path().join("Ideas.md"), "").unwrap();
        assert_eq!(
            available_path("Ideas", dir.path()),
            dir.path().join("Ideas (2).md")
        );
    }

    #[test]
    fn available_path_collision_check_is_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ideas.md"), "").unwrap();
        // NTFS would refuse "Ideas.md" as a distinct file, so it must
        // disambiguate rather than hand back a name the OS rejects.
        assert_eq!(
            available_path("Ideas", dir.path()),
            dir.path().join("Ideas (2).md")
        );
    }
}
