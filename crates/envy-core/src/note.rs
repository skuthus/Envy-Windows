//! Port of `Sources/EnvyCore/Note.swift`.
//!
//! The macOS original's reasoning is preserved here because it was arrived at
//! empirically and re-deriving it would cost the same measurements twice. In
//! short: title/tags/wikiLinks/lowercased-content used to be recomputed on
//! every access, which `filtered(query:)` does for every note on every
//! keystroke — thousands of regex passes per keystroke at a few thousand
//! notes. Computing them eagerly at construction was tried and was worse: a
//! plain folder scan then had to run every regex and a full lowercasing over
//! every note whether or not anything needed them yet, ballooning reload to
//! 2+ seconds at 10,000 notes. So: computed lazily, once, on first actual
//! read, and cached from then on.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use chrono::NaiveDate;
use fancy_regex::Regex;
use std::sync::LazyLock;

use crate::due::resolve_due_token;

/// Whether a note carries an AI-provenance signature — the "⎈ created/edited
/// by … · <date>" line an external AI connector stamps as the last line. Envy
/// itself never writes these; it only reads them, to surface which notes an AI
/// touched. A self-attested claim, not something Envy can verify — so UI
/// wording says "marked as," never asserts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AiProvenance {
    /// No signature — a purely human note.
    #[default]
    None,
    /// Authored from scratch by an AI.
    Created,
    /// A human note an AI later modified.
    Edited,
}

// --- Patterns ---------------------------------------------------------------
// Transcribed verbatim from Note.swift. Where a pattern is duplicated from
// MarkdownStyler on the Mac side, it stays duplicated here for the same reason
// given there: the styler's copy is private to the UI layer, and one shared
// definition across a module boundary would be a worse coupling than two that
// are individually correct.

/// Whether the character immediately before `at` would make this a mid-word
/// match rather than a real token.
///
/// This is the `(?<![\w])` that `TAG_RE` and `DUE_RE` used to carry. It was
/// moved out of the patterns because `fancy-regex` falls back to its own
/// backtracking engine for any expression containing look-around, and
/// delegates everything else to the linear-time `regex` engine. Those two were
/// the only patterns in this file with look-around, and on a 5,000-note vault
/// they cost 126 ms and 140 ms to derive against 2 ms for the look-around-free
/// patterns over the same text — a one-time hit, but paid on the first
/// keystroke of a search.
///
/// The matching rule is unchanged: `word#tag` is still not a tag, `##heading`
/// is still not a tag, and `foo@today` is still not a due token.
fn preceded_by_word_char(text: &str, at: usize) -> bool {
    text[..at]
        .chars()
        .next_back()
        .is_some_and(|c| c.is_alphanumeric() || c == '_')
}

fn followed_by_word_char(text: &str, at: usize) -> bool {
    text[at..]
        .chars()
        .next()
        .is_some_and(|c| c.is_alphanumeric() || c == '_')
}

static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#([A-Za-z0-9_-]+)").unwrap());

static WIKI_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap());

/// The `![[…]]` embed marker. Both an image and a note transclusion use it —
/// which is which is decided by the target's extension, against
/// [`IMAGE_ATTACHMENT_EXTENSIONS`].
static EMBED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\[\]]+)\]\]").unwrap());

/// The extensions that make an `![[…]]` an image rather than a note embed.
///
/// The single source of truth for that split — the styler reads the same set,
/// so search and the editor never disagree on what counts as an image. Kept in
/// step with the Mac's `Note.imageAttachmentExtensions`.
pub static IMAGE_ATTACHMENT_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "tif", "bmp",
];

/// Whether `name` (an embed target, size and caption already stripped) points
/// at an image rather than another note.
pub fn is_image_attachment(name: &str) -> bool {
    name.rsplit('.')
        .next()
        .filter(|ext| *ext != name) // no extension at all → not an image
        .map(str::to_ascii_lowercase)
        .is_some_and(|ext| IMAGE_ATTACHMENT_EXTENSIONS.contains(&ext.as_str()))
}

static AI_SIGNATURE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^⎈[ \t]+(created|edited)\b").unwrap());

static UNCHECKED_TASK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*(?:[-*+][ \t]+)?\[ \][ \t]+").unwrap());

static DUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)@(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[0-9/-]+)",
    )
    .unwrap()
});

static STRIKETHROUGH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"~~([^~\n]+)~~").unwrap());

static CHECKED_TASK_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*(?:[-*+][ \t]+)?\[[xX]\][ \t]+.*$").unwrap());

/// Everything derived from `(url, content)`, each computed at most once.
///
/// Held behind an `Arc` rather than inline on `Note` for the same reason the
/// Swift version used a class: cloning a `Note` shares the cache instead of
/// discarding it, so passing notes around by value (which search does
/// constantly, over a snapshot, on a background thread) doesn't throw away
/// work. `OnceLock` is the direct equivalent of the Swift original's
/// lock-guarded compute-once properties — and it's there for the same reason
/// `lazy var` was rejected: search runs on a background thread over the same
/// notes the UI thread is rendering, so two threads genuinely can race the
/// first access.
#[derive(Debug, Default)]
struct NoteDerived {
    title: OnceLock<String>,
    lowercased_title: OnceLock<String>,
    lowercased_content: OnceLock<String>,
    tags: OnceLock<BTreeSet<String>>,
    wiki_links: OnceLock<BTreeSet<String>>,
    has_unchecked_task: OnceLock<bool>,
    /// `(has_image_embed, has_note_embed)` — both derived in one pass over the
    /// `![[…]]` markers, behind a cheap `contains` early-out so a note with no
    /// embed at all pays nothing.
    embed_kinds: OnceLock<(bool, bool)>,
    preview: OnceLock<String>,
    active_due_dates: OnceLock<Vec<NaiveDate>>,
    ai_provenance: OnceLock<AiProvenance>,
}

#[derive(Debug, Clone)]
pub struct Note {
    id: String,
    url: PathBuf,
    content: String,
    pub modified: SystemTime,
    derived: Arc<NoteDerived>,
}

impl Note {
    pub fn new(url: impl Into<PathBuf>, content: impl Into<String>, modified: SystemTime) -> Self {
        let url = url.into();
        Self {
            id: url.to_string_lossy().into_owned(),
            url,
            content: content.into(),
            modified,
            derived: Arc::new(NoteDerived::default()),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn url(&self) -> &Path {
        &self.url
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    /// Mirrors the Swift `didSet` on `content`: changing it invalidates every
    /// derived value at once by swapping in a fresh cache, rather than trying
    /// to figure out which ones are still valid.
    pub fn set_content(&mut self, content: impl Into<String>) {
        let content = content.into();
        if content == self.content {
            return;
        }
        self.content = content;
        self.derived = Arc::new(NoteDerived::default());
    }

    /// Same, for a rename.
    pub fn set_url(&mut self, url: impl Into<PathBuf>) {
        let url = url.into();
        if url == self.url {
            return;
        }
        self.id = url.to_string_lossy().into_owned();
        self.url = url;
        self.derived = Arc::new(NoteDerived::default());
    }

    /// The filename without extension — the note's title. A note's name *is*
    /// its filename; there is no separate stored title.
    pub fn title(&self) -> &str {
        self.derived.title.get_or_init(|| {
            let name = self
                .url
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.is_empty() {
                "Untitled".to_string()
            } else {
                name
            }
        })
    }

    pub fn lowercased_title(&self) -> &str {
        // Resolved before `get_or_init` so the two caches aren't entered
        // re-entrantly — the Swift version had to do the same dance to avoid
        // deadlocking on its non-recursive lock.
        let title = self.title().to_lowercase();
        self.derived.lowercased_title.get_or_init(|| title)
    }

    pub fn lowercased_content(&self) -> &str {
        self.derived
            .lowercased_content
            .get_or_init(|| self.content.to_lowercase())
    }

    /// `#word`-style hashtags found anywhere in the content, lowercased for
    /// case-insensitive matching. The negative lookbehind excludes a `#`
    /// preceded by a word character (mid-word, not a tag) or another `#`
    /// (which would otherwise match inside `## Heading`); markdown headings
    /// themselves are already excluded since they require a space after the
    /// `#`, which this pattern doesn't allow.
    pub fn tags(&self) -> &BTreeSet<String> {
        self.derived.tags.get_or_init(|| {
            TAG_RE
                .captures_iter(&self.content)
                .filter_map(|c| c.ok())
                .filter_map(|c| {
                    let start = c.get(0)?.start();
                    // `#` itself is excluded as well as word characters, so
                    // the second `#` of a `## Heading` doesn't open a tag.
                    if preceded_by_word_char(&self.content, start)
                        || self.content[..start].ends_with('#')
                    {
                        return None;
                    }
                    c.get(1).map(|m| m.as_str().to_lowercase())
                })
                .collect()
        })
    }

    /// Titles of every note this one links to via `[[Title]]`, lowercased.
    /// Stores the link *target*, not the raw body — otherwise `[[Note|alias]]`
    /// registers a link to a note called "Note|alias", which can't exist, and
    /// the real note loses its backlink.
    pub fn wiki_links(&self) -> &BTreeSet<String> {
        self.derived.wiki_links.get_or_init(|| {
            WIKI_LINK_RE
                .captures_iter(&self.content)
                .filter_map(|c| c.ok())
                .filter_map(|c| c.get(1))
                .filter_map(|m| {
                    let target = WikiLink::parse(m.as_str()).target.to_lowercase();
                    (!target.is_empty()).then_some(target)
                })
                .collect()
        })
    }

    pub fn ai_provenance(&self) -> AiProvenance {
        *self.derived.ai_provenance.get_or_init(|| {
            match AI_SIGNATURE_RE
                .captures(&self.content)
                .ok()
                .flatten()
                .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            {
                Some(verb) if verb == "created" => AiProvenance::Created,
                Some(_) => AiProvenance::Edited,
                None => AiProvenance::None,
            }
        })
    }

    /// Whether at least one still-unchecked task-list item exists — backs the
    /// `todo:` search operator. Stops at the first hit rather than scanning
    /// the rest of the note, so it's cheaper than tags/wiki_links.
    pub fn has_unchecked_task(&self) -> bool {
        *self.derived.has_unchecked_task.get_or_init(|| {
            UNCHECKED_TASK_RE
                .find(&self.content)
                .ok()
                .flatten()
                .is_some()
        })
    }

    /// Whether the note embeds at least one image — backs the `img:` operator.
    pub fn has_image_embed(&self) -> bool {
        self.embed_kinds().0
    }

    /// Whether the note transcludes at least one other note — backs `embed:`.
    pub fn has_note_embed(&self) -> bool {
        self.embed_kinds().1
    }

    /// `(image, note)`, computed once over the `![[…]]` markers. The `contains`
    /// guard is the whole reason this is cheap: the majority of notes have no
    /// `![[` at all and never touch the regex.
    fn embed_kinds(&self) -> (bool, bool) {
        *self.derived.embed_kinds.get_or_init(|| {
            if !self.content.contains("![[") {
                return (false, false);
            }
            let mut has_image = false;
            let mut has_note = false;
            for caps in EMBED_RE.captures_iter(&self.content).filter_map(|c| c.ok()) {
                let Some(inner) = caps.get(1) else { continue };
                // The name is everything up to the first `|` — the size and
                // caption slots, if any, come after it.
                let name = inner.as_str().split('|').next().unwrap_or("");
                if is_image_attachment(name) {
                    has_image = true;
                } else {
                    has_note = true;
                }
                if has_image && has_note {
                    break;
                }
            }
            (has_image, has_note)
        })
    }

    /// Every *active* `@…` token's resolved date, earliest first. "Active"
    /// means neither of the two ways a due token gets retired:
    ///
    /// - **Crossed out**: inside a `~~…~~` span. Deliberately broader than
    ///   "did a click wrap exactly this token" — crossing out a whole sentence
    ///   that happens to contain a due token should retire it too.
    /// - **On a checked task line**: `- [x] Ship the report @04-16-26` retires
    ///   the token without any `~~` on disk, since completed-task styling is a
    ///   rendering overlay rather than written markup. Detected directly here.
    ///
    /// Sorted rather than "first token in reading order" because `due()` is
    /// the *earliest* of these — the one that determines urgency. A note
    /// mentioning a later date before an earlier one used to report the later,
    /// less urgent date as "the" due date purely because of where it sat in
    /// the text. That was a real bug, not a design choice.
    pub fn active_due_dates(&self) -> &[NaiveDate] {
        self.derived.active_due_dates.get_or_init(|| {
            // The boundary check that used to be `(?<![\w])…(?!\w)` inside the
            // pattern. Discarding a match here can't hide an overlapping one:
            // every match starts with `@`, and no alternation branch contains
            // an `@`, so nothing can start inside a rejected match.
            let matches: Vec<_> = DUE_RE
                .captures_iter(&self.content)
                .filter_map(|c| c.ok())
                .filter(|c| {
                    c.get(0).is_some_and(|m| {
                        !preceded_by_word_char(&self.content, m.start())
                            && !followed_by_word_char(&self.content, m.end())
                    })
                })
                .collect();
            // Most notes have no due token at all — skip both exclusion scans
            // entirely rather than always paying for them to find nothing.
            if matches.is_empty() {
                return Vec::new();
            }

            let mut retired: Vec<(usize, usize)> = Vec::new();
            for re in [&*STRIKETHROUGH_RE, &*CHECKED_TASK_LINE_RE] {
                retired.extend(
                    re.find_iter(&self.content)
                        .filter_map(|m| m.ok())
                        .map(|m| (m.start(), m.end())),
                );
            }
            let is_retired = |s: usize, e: usize| {
                retired.iter().any(|&(x, y)| s < y && e > x)
            };

            let mut dates: Vec<NaiveDate> = matches
                .iter()
                .filter_map(|c| {
                    let whole = c.get(0)?;
                    if is_retired(whole.start(), whole.end()) {
                        return None;
                    }
                    // An unparseable token just means no due date, not a
                    // crash — the same forgiving failure mode as a malformed
                    // tag or wiki-link.
                    resolve_due_token(c.get(1)?.as_str(), today())
                })
                .collect();
            dates.sort_unstable();
            dates
        })
    }

    /// The *earliest* active due date, if any.
    pub fn due(&self) -> Option<NaiveDate> {
        self.active_due_dates().first().copied()
    }

    /// How many distinct active due dates — 1 in the common case, more if a
    /// note tracks several sub-tasks each with their own token. Backs the
    /// "+N" badge beside the due pill, so a note with several due dates
    /// doesn't quietly look like it has only the soonest one.
    pub fn due_date_count(&self) -> usize {
        self.active_due_dates().len()
    }

    /// A single-line snippet for the note list row. The row truncates to one
    /// line, so only the first line's worth can ever render — the cap is what
    /// makes this cheap, and the manual line walk (rather than splitting the
    /// whole content) is what makes the cap real.
    pub fn preview(&self) -> &str {
        self.derived.preview.get_or_init(|| {
            const CAP: usize = 200;
            let mut result = String::new();
            for line in self.content.lines() {
                if result.chars().count() >= CAP {
                    break;
                }
                if line.is_empty() {
                    continue;
                }
                if !result.is_empty() {
                    result.push(' ');
                }
                result.push_str(line);
            }
            result
        })
    }
}

fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(content: &str) -> Note {
        Note::new("C:/Index/Test Note.md", content, SystemTime::UNIX_EPOCH)
    }

    #[test]
    fn title_comes_from_the_filename() {
        assert_eq!(note("anything").title(), "Test Note");
        assert_eq!(
            Note::new("C:/Index/Multi.Dot.Name.md", "", SystemTime::UNIX_EPOCH).title(),
            "Multi.Dot.Name"
        );
    }

    /// The "Untitled" fallback is effectively unreachable in practice — a
    /// scan never yields a dot-prefixed file (the Mac side excludes them via
    /// `skipsHiddenFiles`, and the Windows scan will mirror that), and every
    /// other filename has a non-empty stem. It stays as a total-function
    /// guard, not because a caller is expected to hit it.
    #[test]
    fn empty_stem_falls_back_to_untitled() {
        assert_eq!(Note::new("", "", SystemTime::UNIX_EPOCH).title(), "Untitled");
    }

    #[test]
    fn tags_exclude_headings_and_mid_word_hashes() {
        let n = note("# Heading\n## Also heading\nA #real tag and #another-one.\nNot mid#word.");
        let tags: Vec<_> = n.tags().iter().cloned().collect();
        assert_eq!(tags, vec!["another-one".to_string(), "real".to_string()]);
    }

    /// The boundary rules used to live inside the patterns as look-around.
    /// These pin the cases where hand-rolling them could have diverged: a
    /// rejected match must not swallow a real one that follows, and a trailing
    /// non-word character must still be allowed to end a token.
    #[test]
    fn tag_boundaries_survive_a_rejected_match() {
        // "##no" is rejected; "#yes" right after it must still be found.
        let n = note("##no #yes\nmid#word #tail");
        let tags: Vec<_> = n.tags().iter().cloned().collect();
        assert_eq!(tags, vec!["tail".to_string(), "yes".to_string()]);
    }

    #[test]
    fn due_token_needs_a_word_boundary_on_both_sides() {
        // Trailing word character → not a token.
        assert!(note("ship it @todays").due().is_none());
        assert!(note("ship it @2026-01-01x").due().is_none());
        // Leading word character → not a token.
        assert!(note("email me@today").due().is_none());
        // A trailing non-word character is fine, and must not eat the token.
        assert!(note("ship it @today.").due().is_some());
        assert!(note("(@today)").due().is_some());
    }

    #[test]
    fn a_rejected_due_token_does_not_hide_a_later_one() {
        let n = note("not @todayx but really @today");
        assert_eq!(n.active_due_dates().len(), 1);
    }

    #[test]
    fn wiki_links_store_the_target_not_the_raw_body() {
        // The alias and heading forms must both resolve to "meeting notes",
        // otherwise the real note loses its backlink.
        let n = note("[[Meeting Notes]] [[Meeting Notes|last Tuesday]] [[Meeting Notes#Agenda]]");
        let links: Vec<_> = n.wiki_links().iter().cloned().collect();
        assert_eq!(links, vec!["meeting notes".to_string()]);
    }

    #[test]
    fn embeds_register_as_links_too() {
        let n = note("![[Daily Template]]");
        assert!(n.wiki_links().contains("daily template"));
    }

    #[test]
    fn due_is_the_earliest_not_the_first_in_reading_order() {
        let n = note("Ship @12-31-26 but first draft @01-05-26.");
        assert_eq!(n.due(), Some(NaiveDate::from_ymd_opt(2026, 1, 5).unwrap()));
        assert_eq!(n.due_date_count(), 2);
    }

    #[test]
    fn struck_out_due_tokens_are_retired() {
        let n = note("~~Abandoned @01-05-26~~ and live @02-05-26.");
        assert_eq!(n.due(), Some(NaiveDate::from_ymd_opt(2026, 2, 5).unwrap()));
        assert_eq!(n.due_date_count(), 1);
    }

    #[test]
    fn checked_task_lines_retire_their_due_tokens() {
        let n = note("- [x] Ship the report @01-05-26\n- [ ] Draft the next one @02-05-26");
        assert_eq!(n.due(), Some(NaiveDate::from_ymd_opt(2026, 2, 5).unwrap()));
        assert_eq!(n.due_date_count(), 1);
    }

    #[test]
    fn an_at_mention_is_not_a_due_date() {
        assert_eq!(note("Ask @skyler about it").due(), None);
        assert_eq!(note("Due @mondayish maybe").due(), None);
        // Trailing punctuation must not be swallowed into the token — the
        // greedy \S+ this replaced captured "04-16-26," and then silently
        // produced no due date at all.
        assert_eq!(
            note("Call @04-16-26, then follow up").due(),
            Some(NaiveDate::from_ymd_opt(2026, 4, 16).unwrap())
        );
    }

    #[test]
    fn ai_provenance_reads_the_helm_signature() {
        assert_eq!(note("plain note").ai_provenance(), AiProvenance::None);
        assert_eq!(
            note("body\n⎈ created by Claude · 2026-07-25").ai_provenance(),
            AiProvenance::Created
        );
        assert_eq!(
            note("body\n⎈ edited by Claude · 2026-07-25").ai_provenance(),
            AiProvenance::Edited
        );
    }

    #[test]
    fn unchecked_task_detection() {
        assert!(note("- [ ] todo").has_unchecked_task());
        assert!(note("[ ] bare marker").has_unchecked_task());
        assert!(!note("- [x] done").has_unchecked_task());
        assert!(!note("no tasks here").has_unchecked_task());
    }

    #[test]
    fn preview_collapses_lines_and_skips_blanks() {
        let n = note("First line\n\nSecond line\nThird");
        assert_eq!(n.preview(), "First line Second line Third");
    }

    /// The 200-char cap gates the *loop*, not the append: once `result` is at
    /// or past the cap no further line is read, but whichever line is being
    /// appended goes in whole. So many short lines stop just past 200, while a
    /// single long line comes through at full length. That is exactly what the
    /// Swift does, and the list row truncates to one line visually anyway —
    /// the cap exists to bound *work*, not output width.
    #[test]
    fn preview_cap_bounds_lines_read_not_the_final_length() {
        let many_short = note(&"0123456789\n".repeat(100));
        let len = many_short.preview().chars().count();
        assert!((200..250).contains(&len), "expected ~200, got {len}");

        let one_long = note(&"word ".repeat(200));
        assert_eq!(one_long.preview().chars().count(), 1000);
    }

    #[test]
    fn wiki_link_parse_matches_the_swift_shapes() {
        let plain = WikiLink::parse("Meeting Notes");
        assert_eq!(plain.target, "Meeting Notes");
        assert_eq!(plain.display, "Meeting Notes");
        assert_eq!(plain.alias_pipe_offset, None);

        let alias = WikiLink::parse("Meeting Notes|last Tuesday");
        assert_eq!(alias.target, "Meeting Notes");
        assert_eq!(alias.display, "last Tuesday");
        assert_eq!(alias.alias_pipe_offset, Some(13));

        let heading = WikiLink::parse("Meeting Notes#Agenda");
        assert_eq!(heading.target, "Meeting Notes");
        // Shown as written — the link goes to the note, and the reader can
        // see which part was meant.
        assert_eq!(heading.display, "Meeting Notes#Agenda");
    }

    #[test]
    fn mutating_content_invalidates_the_derived_cache() {
        let mut n = note("#before");
        assert!(n.tags().contains("before"));
        n.set_content("#after");
        assert!(n.tags().contains("after"));
        assert!(!n.tags().contains("before"));
    }
}

impl PartialEq for Note {
    /// Custom rather than derived: the cache is a pure function of
    /// `url`/`content`, so comparing it too would be redundant work on top of
    /// the fields that already fully determine equality.
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.url == other.url
            && self.content == other.content
            && self.modified == other.modified
    }
}
impl Eq for Note {}

/// Splits the inside of a `[[…]]` into the note it points at and the text a
/// reader sees.
///
/// Envy understands two pieces of Obsidian's link syntax:
///
/// - `[[Note|Anything]]` — an alias. The target is `Note`, the reader sees
///   `Anything`, so a link can sit inside a sentence without the filename
///   interrupting it.
/// - `[[Note#Heading]]` — a heading reference. Envy does not jump to the
///   heading, but it resolves the link to `Note` rather than treating the
///   whole string as a title.
///
/// The second is deliberately partial. Handling it this far means notes pasted
/// in from Obsidian resolve, back-link, and survive a rename instead of
/// breaking silently, and real heading support can be added later without a
/// migration — the stored text is already correct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedWikiLink {
    /// The note title to resolve. Never contains an alias or heading.
    pub target: String,
    /// What the reader sees. Equals the raw body unless an alias is given.
    pub display: String,
    /// Byte offset of the `|` within the body, when there is one — the styler
    /// needs it to collapse the target half out of view.
    pub alias_pipe_offset: Option<usize>,
}

pub struct WikiLink;

impl WikiLink {
    pub fn parse(body: &str) -> ParsedWikiLink {
        let pipe_index = body.find('|');
        let target_part = pipe_index.map_or(body, |i| &body[..i]);
        // Everything from the first '#' is a heading reference, not part of
        // the note's name.
        let without_heading = target_part.split('#').next().unwrap_or("");
        let target = without_heading.trim().to_string();

        let display = match pipe_index {
            Some(i) => body[i + 1..].trim().to_string(),
            // No alias: show it as written. For a heading reference that
            // includes the heading, which is honest — the link goes to the
            // note, and the reader can see which part was meant.
            None => body.trim().to_string(),
        };

        ParsedWikiLink {
            display: if display.is_empty() {
                target.clone()
            } else {
                display
            },
            target,
            alias_pipe_offset: pipe_index,
        }
    }
}
