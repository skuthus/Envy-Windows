//! Port of `NoteStore.filtered(_:query:)` and its supporting machinery.
//!
//! Semantics, in one place:
//!
//! - A query splits on commas into **groups**, which are OR-ed. Within a
//!   group everything AND-s together.
//! - A group splits on spaces into **tokens**, except inside double quotes —
//!   so `link:"Meeting Notes"` keeps its space, and so does a quoted phrase.
//! - A **closed** quote is exact, matched on word boundaries: `"nee"` finds
//!   the word *nee*, not the *nee* inside *needed*. An **open** quote (still
//!   being typed) stays a substring term so results appear as you type. That
//!   open-vs-closed distinction is the whole point of the quote handling.
//! - Only the first `tag:` / `date:` / `due:` / `link:` of each polarity is
//!   honored; combining several has ambiguous AND-vs-OR semantics not worth
//!   guessing at (comma groups are what OR is for). Every `-` exclusion is
//!   honored, since excluding more than one thing has no such ambiguity.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Weekday};

use crate::due::parse_flexible_date;
use crate::note::{AiProvenance, Note};

pub const INBOX_FOLDER_NAME: &str = "Inbox";

/// Everything time-dependent, passed in rather than read from the clock.
///
/// The Swift original calls `Date()` and `Calendar.current` inside each helper,
/// which makes the whole search path untestable without freezing system time —
/// several of its own doc comments note the problem. Threading a context
/// through costs one parameter and buys deterministic tests.
#[derive(Debug, Clone, Copy)]
pub struct SearchContext {
    pub now: DateTime<Local>,
    pub week_start: Weekday,
}

impl SearchContext {
    pub fn now() -> Self {
        Self {
            now: Local::now(),
            week_start: crate::due::DEFAULT_WEEK_START,
        }
    }

    fn today(&self) -> NaiveDate {
        self.now.date_naive()
    }
}

/// What an `ai:` / `-ai:` token constrains to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiFilter {
    Any,
    Created,
    Edited,
}

impl AiFilter {
    fn matches(self, p: AiProvenance) -> bool {
        match self {
            AiFilter::Any => p != AiProvenance::None,
            AiFilter::Created => p == AiProvenance::Created,
            AiFilter::Edited => p == AiProvenance::Edited,
        }
    }

    /// `None` for an unrecognized value (`ai:cats`) — treated as no
    /// constraint, the lenient handling `date:` uses rather than `due:`'s
    /// stricter match-nothing.
    fn parse(suffix: &str) -> Option<Self> {
        match suffix {
            "" => Some(AiFilter::Any),
            "created" => Some(AiFilter::Created),
            "edited" => Some(AiFilter::Edited),
            _ => None,
        }
    }
}

/// What a `due:` value resolved to. `Overdue` and `Future` are open-ended
/// rather than a `[start, end)` window, so they get their own variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DueCondition {
    Any,
    Overdue,
    Future,
    Range { start: NaiveDate, end: NaiveDate },
}

/// Splits a group into tokens on spaces, except inside double quotes.
pub fn tokenize(q: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in q.chars() {
        if ch == '"' {
            in_quotes = !in_quotes;
            current.push(ch);
        } else if ch == ' ' && !in_quotes {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Drops surrounding double quotes. Tolerant of a missing closing one, so a
/// phrase still being typed — `"mater` — searches as `mater` and shows results
/// as you go, rather than looking for the literal `"mater` and finding nothing
/// until the quote is finished.
pub fn unquote(text: &str) -> String {
    let mut s = text;
    if let Some(rest) = s.strip_prefix('"') {
        s = rest;
    }
    if let Some(rest) = s.strip_suffix('"') {
        s = rest;
    }
    s.to_string()
}

/// Splits a query into its comma-separated OR groups — but only on commas
/// *outside* double quotes, the same quote handling `tokenize` uses.
///
/// A naive split broke any quoted argument containing a comma:
/// `interlink:"Debrief (Sep 24, 2025)"` split mid-title into two meaningless
/// groups, and it had silently broken `link:` and quoted phrases with commas
/// all along. An unterminated quote swallows every comma after it, matching how
/// an open quote already behaves for spaces.
fn split_groups(query: &str) -> Vec<String> {
    let mut groups = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in query.chars() {
        if ch == '"' {
            in_quotes = !in_quotes;
            current.push(ch);
        } else if ch == ',' && !in_quotes {
            let g = current.trim();
            if !g.is_empty() {
                groups.push(g.to_string());
            }
            current.clear();
        } else {
            current.push(ch);
        }
    }
    let g = current.trim();
    if !g.is_empty() {
        groups.push(g.to_string());
    }
    groups
}

/// An operator's argument (`tag:x`, `folder:"Work"`), split into its text and
/// whether it was quoted.
///
/// Quoting *demands exactness* — `tag:"work"` matches only `#work`,
/// `folder:"Work"` only that folder and its descendants — while a bare argument
/// keeps the friendlier partial match (`tag:techn` finds `#technology`). The
/// tag and folder browsers generate the quoted form, so the count a row shows is
/// exactly what clicking it yields. `None` for an empty argument.
fn operator_argument(raw: &str) -> Option<(String, bool)> {
    let quoted = raw.starts_with('"');
    let text = unquote(raw);
    if text.is_empty() {
        None
    } else {
        Some((text, quoted))
    }
}

/// `folder:`'s matching rule. Exact means the folder itself or anything nested
/// inside it; partial means the path merely contains the text (so `work` also
/// hits `workshop` — fine while typing, wrong for a click on a specific folder).
fn folder_matches(path: &str, filter: &(String, bool)) -> bool {
    let (text, exact) = filter;
    if *exact {
        path == text || path.starts_with(&format!("{text}/"))
    } else {
        fast_contains(path, text)
    }
}

/// `tag:`'s matching rule — the same shape as [`folder_matches`], minus the
/// descendant case, since tags have no hierarchy.
fn tag_matches(tag: &str, filter: &(String, bool)) -> bool {
    let (text, exact) = filter;
    if *exact {
        tag == text
    } else {
        fast_contains(tag, text)
    }
}

/// A note's folder path relative to the Index root, lowercased — `""` at the
/// root, `projects/work` when nested. What `folder:` matches against.
///
/// Without a root there is no way to know where the vault starts, so the
/// fallback is the immediate parent folder's name alone.
fn relative_folder_path(note: &Note, root_lower: Option<&str>) -> String {
    let parent = note.url().parent();
    let parent_name = || {
        parent
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    let Some(root_lower) = root_lower else {
        return parent_name();
    };
    let Some(parent) = parent else {
        return String::new();
    };
    // Separators normalised so the comparison holds whichever way the path was
    // built — folder: keys are plain relative paths, not platform ones.
    let parent = parent.to_string_lossy().replace('\\', "/").to_lowercase();
    if parent == root_lower {
        String::new()
    } else if let Some(rest) = parent.strip_prefix(&format!("{root_lower}/")) {
        rest.to_string()
    } else {
        parent_name()
    }
}

fn fast_contains(haystack: &str, needle: &str) -> bool {
    haystack.contains(needle)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether `needle` appears in `haystack` on word boundaries.
///
/// Both are already lowercased by the caller, so this is a plain substring
/// scan plus a check of the characters either side — no regex at all.
///
/// It *was* a regex, mirroring the Mac's `(?<![\p{L}\p{N}_])…(?!…)`. On a
/// 5,000-note vault that made a quoted phrase search cost 131 ms against
/// well under 1 ms for every other query — a hundred and sixty times the next
/// slowest thing, and far too slow for something that runs on every keystroke.
/// The Mac gets away with the pattern because NSRegularExpression is ICU;
/// `fancy-regex` backtracks, and it does so across every note's full text.
///
/// The boundary rule is unchanged, which is what matters: a closed-quote
/// search for "nee" still finds the word *nee* and not the *nee* inside
/// *needed*.
fn whole_word_contains(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        let before_ok = haystack[..start].chars().next_back().is_none_or(|c| !is_word_char(c));
        let after_ok = haystack[end..].chars().next().is_none_or(|c| !is_word_char(c));
        if before_ok && after_ok {
            return true;
        }
        // Advance by one char, not one byte, or a multi-byte character here
        // would panic on a non-boundary slice.
        from = start + haystack[start..].chars().next().map_or(1, char::len_utf8);
        if from >= haystack.len() {
            break;
        }
    }
    false
}

/// The `[start, end)` window a `date:` query resolves to — a single calendar
/// day for an exact date or today/yesterday, or a rolling window ending now
/// for week/month. `None` for anything unrecognized, which the filter treats
/// as "show everything" rather than silently returning zero results for a typo.
fn date_range(query: &str, ctx: &SearchContext) -> Option<(DateTime<Local>, DateTime<Local>)> {
    if query.is_empty() {
        return None;
    }
    let now = ctx.now;
    let start_of_day = |d: NaiveDate| Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).single();

    match query {
        "today" => {
            let s = start_of_day(ctx.today())?;
            Some((s, s + Duration::days(1)))
        }
        "yesterday" => {
            let today = start_of_day(ctx.today())?;
            Some((today - Duration::days(1), today))
        }
        "week" => Some((now - Duration::days(7), now)),
        "month" => Some((now - Duration::days(30), now)),
        _ => {
            let d = parse_flexible_date(query)?;
            let s = start_of_day(d)?;
            Some((s, s + Duration::days(1)))
        }
    }
}

/// The cutoff for `stale:` — notes untouched since this instant are stale.
///
/// `stale:` is `date:`'s complement: where `date:` asks what was edited inside
/// a window, this asks what hasn't been edited since one. Bare `stale:` means
/// six months, long enough that whatever it surfaces is genuinely out of mind
/// rather than merely last week's work.
///
/// `None` for a value that isn't a recognized period, which the filter treats
/// as "no constraint" — the same lenient fallback `date:` takes, so a typo
/// shows everything rather than an unexplained empty list.
fn stale_cutoff(query: &str, ctx: &SearchContext) -> Option<DateTime<Local>> {
    let v = query.trim().to_lowercase();
    let now = ctx.now;
    if v.is_empty() {
        return Some(now - Duration::days(182));
    }
    match v.as_str() {
        "week" => Some(now - Duration::days(7)),
        "month" => Some(now - Duration::days(30)),
        "year" => Some(now - Duration::days(365)),
        _ => {
            // A bare number of days, with an optional "d" — `stale:90` and
            // `stale:90d` are the same question.
            let digits = v.strip_suffix('d').unwrap_or(&v);
            let days: i64 = digits.parse().ok()?;
            if days <= 0 {
                return None;
            }
            Some(now - Duration::days(days))
        }
    }
}

/// The `[start, end)` window a `due:` bucket resolves to.
///
/// Deliberately separate from `date_range`: `date:week`/`date:month` look
/// *backward* (modification times are naturally in the past — "recently
/// edited"), while a due date is naturally in the *future*, so `due:month`
/// looks forward instead. Reusing the backward window here would make
/// `due:month` silently mean "was due last month," which isn't what it says.
///
/// `week`/`nextweek` are calendar-aligned rather than rolling, which is what
/// "due this week" actually means: it includes days earlier in the current
/// week that have already passed.
fn due_range(query: &str, ctx: &SearchContext) -> Option<(NaiveDate, NaiveDate)> {
    if query.is_empty() {
        return None;
    }
    let today = ctx.today();
    match query {
        "today" => Some((today, today + Duration::days(1))),
        // Single-day windows, exactly like today — not "tomorrow and
        // everything after" (that's what week/month are for). Without an
        // explicit case these would fall through to the date parse, fail, and
        // be treated as "no filter, show everything" — the right fallback for
        // a genuine typo, but "tomorrow" isn't a typo.
        "tomorrow" => Some((today + Duration::days(1), today + Duration::days(2))),
        "yesterday" => Some((today - Duration::days(1), today)),
        "week" => {
            let w = today.week(ctx.week_start);
            Some((w.first_day(), w.last_day() + Duration::days(1)))
        }
        "nextweek" => {
            let w = (today + Duration::weeks(1)).week(ctx.week_start);
            Some((w.first_day(), w.last_day() + Duration::days(1)))
        }
        "month" => Some((today, today + Duration::days(30))),
        _ => {
            let d = parse_flexible_date(query)?;
            Some((d, d + Duration::days(1)))
        }
    }
}

/// `None` means *invalid*, not "no filter" — see the `due:cats` reasoning on
/// `GroupQuery::due_invalid`.
fn due_condition(value: &str, ctx: &SearchContext) -> Option<DueCondition> {
    if value.is_empty() {
        return Some(DueCondition::Any);
    }
    // "past" is a plain alias for "overdue" — same meaning, for anyone who
    // reaches for past/future as the natural opposite pair.
    if value == "overdue" || value == "past" {
        return Some(DueCondition::Overdue);
    }
    if value == "future" {
        return Some(DueCondition::Future);
    }
    due_range(value, ctx).map(|(start, end)| DueCondition::Range { start, end })
}

fn due_condition_matches(c: DueCondition, note: &Note, today: NaiveDate) -> bool {
    match c {
        DueCondition::Any => note.due().is_some(),
        DueCondition::Overdue => note.due().is_some_and(|d| d < today),
        // The exact complement of Overdue — same threshold, flipped
        // comparison. Like Overdue, an undated note matches neither: "future"
        // isn't "undated," it's "dated and not yet due."
        DueCondition::Future => note.due().is_some_and(|d| d >= today),
        DueCondition::Range { start, end } => note.due().is_some_and(|d| d >= start && d < end),
    }
}

/// Membership is the folder the file sits in — there's no flag on a note
/// saying it's fleeting, and there shouldn't be: moving one out of `Inbox/` in
/// Explorer should file it just as surely as pressing Submit does.
pub fn is_inbox_note(note: &Note) -> bool {
    note.url()
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == INBOX_FOLDER_NAME)
}

fn modified_datetime(note: &Note) -> Option<DateTime<Local>> {
    Some(DateTime::<Local>::from(note.modified))
}

/// An operator argument and whether it was quoted (and so exact). See
/// [`operator_argument`].
type Arg = (String, bool);

#[derive(Default)]
struct GroupQuery {
    tag: Option<Arg>,
    exclude_tags: Vec<Arg>,
    /// Bare `tag:` — carries any tag at all; bare `-tag:` — completely untagged.
    /// Together `-tag: orphan: stale:` is the full hygiene sweep.
    tagged_only: bool,
    untagged_only: bool,
    /// `folder:name` (partial) or `folder:"name"` (exact-or-descendant).
    folder: Option<Arg>,
    exclude_folders: Vec<Arg>,
    /// Bare `folder:` — any note in a subfolder; bare `-folder:` — the unfiled
    /// notes at the Index root.
    foldered_only: bool,
    root_only: bool,
    /// `title:word` restricts matching to titles only; several AND together.
    title_terms: Vec<String>,
    exclude_titles: Vec<String>,
    /// `interlink:Target` — connected in either direction. First one wins.
    interlink: Option<String>,
    exclude_interlinks: Vec<String>,
    /// `img:` / `embed:` — holds an image / transcludes another note.
    image_only: bool,
    image_excluded: bool,
    embed_only: bool,
    embed_excluded: bool,
    /// `ghost:` — has an unresolved `[[link]]`; `-ghost:` — every link resolves.
    ghost_only: bool,
    ghost_excluded: bool,
    date: Option<(DateTime<Local>, DateTime<Local>)>,
    /// Notes untouched since this instant. `date:`'s complement.
    stale: Option<DateTime<Local>>,
    exclude_stale: Option<DateTime<Local>>,
    due: Option<DueCondition>,
    exclude_due: Option<DueCondition>,
    /// An unrecognized `due:` value ("due:cats") means *match nothing*, not
    /// "no filter, show everything". `date:`'s fallback intentionally shows
    /// everything so a typo doesn't dump you into a confusing empty list — but
    /// "due:cats" isn't a typo of a real bucket, it's simply invalid, and
    /// silently matching every note hides that rather than surfacing it.
    due_invalid: bool,
    todo_only: bool,
    todo_excluded: bool,
    ai: Option<AiFilter>,
    exclude_ai: Option<AiFilter>,
    inbox_only: bool,
    inbox_excluded: bool,
    link: Option<String>,
    exclude_links: Vec<String>,
    orphan_only: bool,
    linked_only: bool,
    /// Closed-quote phrases, matched on word boundaries. Already lowercased,
    /// like the haystacks they run against — the whole query is lowered before
    /// tokenizing.
    phrase_terms: Vec<String>,
    exclude_phrases: Vec<String>,
    exclude_terms: Vec<String>,
    free_terms: Vec<String>,
}

impl GroupQuery {
    fn has_operator(&self) -> bool {
        self.inbox_only
            || self.inbox_excluded
            || self.link.is_some()
            || !self.exclude_links.is_empty()
            || self.orphan_only
            || self.linked_only
            || self.todo_only
            || self.todo_excluded
            || self.tag.is_some()
            || !self.exclude_tags.is_empty()
            || self.tagged_only
            || self.untagged_only
            || self.folder.is_some()
            || !self.exclude_folders.is_empty()
            || self.foldered_only
            || self.root_only
            || !self.title_terms.is_empty()
            || !self.exclude_titles.is_empty()
            || self.interlink.is_some()
            || !self.exclude_interlinks.is_empty()
            || self.image_only
            || self.image_excluded
            || self.embed_only
            || self.embed_excluded
            || self.ghost_only
            || self.ghost_excluded
            || self.date.is_some()
            || self.stale.is_some()
            || self.exclude_stale.is_some()
            || self.due.is_some()
            || self.exclude_due.is_some()
            || self.due_invalid
            || self.ai.is_some()
            || self.exclude_ai.is_some()
    }

    fn parse(group: &str, ctx: &SearchContext) -> Self {
        let lowered = group.to_lowercase();
        let mut q = GroupQuery::default();
        let mut due_seen = false;
        let mut exclude_due_seen = false;

        for token in tokenize(&lowered) {
            let t = token.as_str();
            if t == "-inbox:" {
                q.inbox_excluded = true;
            } else if let Some(rest) = t.strip_prefix("inbox:") {
                // A bare "inbox:" scopes to fleeting notes; anything after the
                // colon is ordinary search text within them, so it falls
                // through to free terms like any other operator's trailing
                // words.
                q.inbox_only = true;
                if !rest.is_empty() {
                    q.free_terms.push(rest.to_string());
                }
            } else if t == "-todo:" {
                q.todo_excluded = true;
            } else if t == "todo:" {
                q.todo_only = true;
            } else if t == "-img:" {
                q.image_excluded = true;
            } else if let Some(rest) = t.strip_prefix("img:") {
                // Bare "img:" scopes to notes holding an image; trailing text
                // searches within them, the same shape as inbox:.
                q.image_only = true;
                if !rest.is_empty() {
                    q.free_terms.push(rest.to_string());
                }
            } else if t == "-embed:" {
                q.embed_excluded = true;
            } else if let Some(rest) = t.strip_prefix("embed:") {
                // Bare "embed:" scopes to notes that transclude another note.
                q.embed_only = true;
                if !rest.is_empty() {
                    q.free_terms.push(rest.to_string());
                }
            } else if let Some(rest) = t.strip_prefix("-ai:") {
                if q.exclude_ai.is_none() {
                    q.exclude_ai = AiFilter::parse(rest);
                }
            } else if let Some(rest) = t.strip_prefix("ai:") {
                if q.ai.is_none() {
                    q.ai = AiFilter::parse(rest);
                }
            } else if t == "tag:" {
                q.tagged_only = true;
            } else if t == "-tag:" {
                q.untagged_only = true;
            } else if let Some(rest) = t.strip_prefix("-tag:") {
                if let Some(arg) = operator_argument(rest) {
                    q.exclude_tags.push(arg);
                }
            } else if let Some(rest) = t.strip_prefix("tag:") {
                if q.tag.is_none() {
                    q.tag = operator_argument(rest);
                }
            } else if let Some(rest) = t.strip_prefix("-title:") {
                let term = unquote(rest);
                if !term.is_empty() {
                    q.exclude_titles.push(term);
                }
            } else if let Some(rest) = t.strip_prefix("title:") {
                // Restricts matching to titles only — free text also matches
                // bodies, which at a large vault buries the note *named* for a
                // thing under every note that merely mentions it. Several
                // title: terms AND together, like free terms.
                let term = unquote(rest);
                if !term.is_empty() {
                    q.title_terms.push(term);
                }
            } else if let Some(rest) = t.strip_prefix("date:") {
                if q.date.is_none() {
                    q.date = date_range(rest, ctx);
                }
            // Checked before the bare form, or "-stale:week" would be read as a
            // free term beginning with a minus.
            } else if let Some(rest) = t.strip_prefix("-stale:") {
                if q.exclude_stale.is_none() {
                    q.exclude_stale = stale_cutoff(rest, ctx);
                }
            } else if let Some(rest) = t.strip_prefix("stale:") {
                if q.stale.is_none() {
                    q.stale = stale_cutoff(rest, ctx);
                }
            } else if let Some(rest) = t.strip_prefix("-due:") {
                if !exclude_due_seen {
                    exclude_due_seen = true;
                    match due_condition(rest, ctx) {
                        Some(c) => q.exclude_due = Some(c),
                        None => q.due_invalid = true,
                    }
                }
            } else if let Some(rest) = t.strip_prefix("due:") {
                if !due_seen {
                    due_seen = true;
                    match due_condition(rest, ctx) {
                        Some(c) => q.due = Some(c),
                        None => q.due_invalid = true,
                    }
                }
            } else if t == "ghost:" {
                // Notes carrying at least one unresolved [[link]] — the
                // file-list twin of the editor's dimmed ghost links.
                q.ghost_only = true;
            } else if t == "-ghost:" {
                q.ghost_excluded = true;
            } else if t == "linked:" {
                q.linked_only = true;
            } else if t == "orphan:" {
                q.orphan_only = true;
            } else if t == "folder:" {
                q.foldered_only = true;
            } else if t == "-folder:" {
                q.root_only = true;
            } else if let Some(rest) = t.strip_prefix("-folder:") {
                if let Some(arg) = operator_argument(rest) {
                    q.exclude_folders.push(arg);
                }
            } else if let Some(rest) = t.strip_prefix("folder:") {
                // Bare arguments are partial and case-insensitive like tag:,
                // matched against the whole relative path, so a nested folder is
                // findable by any of its segments. Quoted arguments are
                // exact-or-descendant. First one wins.
                if q.folder.is_none() {
                    q.folder = operator_argument(rest);
                }
            } else if let Some(rest) = t.strip_prefix("-interlink:") {
                let target = unquote(rest);
                if !target.is_empty() {
                    q.exclude_interlinks.push(target);
                }
            } else if let Some(rest) = t.strip_prefix("interlink:") {
                // Everything connected to Target in either direction — notes
                // containing [[Target]] plus the notes Target links out to. The
                // Interlinks footer as a searchable list. First one wins.
                if q.interlink.is_none() {
                    let target = unquote(rest);
                    if !target.is_empty() {
                        q.interlink = Some(target);
                    }
                }
            } else if let Some(rest) = t.strip_prefix("-link:") {
                let target = unquote(rest);
                if !target.is_empty() {
                    q.exclude_links.push(target);
                }
            } else if let Some(rest) = t.strip_prefix("link:") {
                if q.link.is_none() {
                    let target = unquote(rest);
                    if !target.is_empty() {
                        q.link = Some(target);
                    }
                }
            } else if let Some(rest) = t.strip_prefix("-\"") {
                let rest = format!("\"{rest}");
                let phrase = unquote(&rest);
                if !phrase.is_empty() {
                    if rest.chars().count() >= 2 && rest.ends_with('"') {
                        q.exclude_phrases.push(phrase);
                    } else {
                        q.exclude_terms.push(phrase);
                    }
                }
            } else if t.starts_with('-') && t.chars().count() > 1 {
                q.exclude_terms.push(t[1..].to_string());
            } else if t.starts_with('"') {
                let phrase = unquote(t);
                if !phrase.is_empty() {
                    if t.chars().count() >= 2 && t.ends_with('"') {
                        q.phrase_terms.push(phrase);
                    } else {
                        q.free_terms.push(phrase);
                    }
                }
            } else {
                q.free_terms.push(t.to_string());
            }
        }
        q
    }
}

/// Number of the given terms found in the note's title (used to rank when
/// several notes match), or `None` if any term is missing from both title and
/// content entirely. An empty term list always matches with score 0 — used
/// when an operator has no free text alongside it.
fn score_by_term_presence(note: &Note, terms: &[String]) -> Option<i32> {
    if terms.is_empty() {
        return Some(0);
    }
    let title = note.lowercased_title();
    let content = note.lowercased_content();
    let mut title_matches = 0;
    for term in terms {
        let in_title = fast_contains(title, term);
        if !in_title && !fast_contains(content, term) {
            return None;
        }
        if in_title {
            title_matches += 1;
        }
    }
    Some(title_matches)
}

fn matched<'a>(
    notes: &'a [Note],
    group: &str,
    ctx: &SearchContext,
    root: Option<&Path>,
) -> Vec<(&'a Note, i32)> {
    let q = GroupQuery::parse(group, ctx);
    let has_operator = q.has_operator();
    let today = ctx.today();

    // Every note anything links *to*, across the corpus — the backlink half of
    // orphan:. Computed once, and only when it's actually needed, since it's a
    // full pass over every note's links.
    let linked_to_titles: HashSet<&str> = if q.orphan_only || q.linked_only {
        notes
            .iter()
            .flat_map(|n| n.wiki_links().iter().map(|s| s.as_str()))
            .collect()
    } else {
        HashSet::new()
    };

    // ghost:'s reference set — every real note title, built only when the
    // operator is present (the same guard linked_to_titles uses).
    let all_note_titles: HashSet<&str> = if q.ghost_only || q.ghost_excluded {
        notes.iter().map(|n| n.lowercased_title()).collect()
    } else {
        HashSet::new()
    };

    // interlink:'s outbound half — what the target note itself links out to.
    // One lookup per group (the inbound half is just each candidate's own
    // wiki_links). A target that doesn't exist leaves this empty, so interlink:
    // degrades gracefully to link:'s inbound-only meaning.
    let interlink_outbound: HashSet<&str> = q
        .interlink
        .as_deref()
        .and_then(|target| notes.iter().find(|n| n.lowercased_title() == target))
        .map(|hub| hub.wiki_links().iter().map(|s| s.as_str()).collect())
        .unwrap_or_default();
    let exclude_interlink_outbound: Vec<(&str, HashSet<&str>)> = q
        .exclude_interlinks
        .iter()
        .map(|target| {
            let outbound = notes
                .iter()
                .find(|n| n.lowercased_title() == target.as_str())
                .map(|hub| hub.wiki_links().iter().map(|s| s.as_str()).collect())
                .unwrap_or_default();
            (target.as_str(), outbound)
        })
        .collect();

    // folder:'s reference point, computed once. The per-note path work only
    // runs when a folder token is actually present.
    let needs_folder_path =
        q.folder.is_some() || !q.exclude_folders.is_empty() || q.foldered_only || q.root_only;
    let root_lower = root.map(|r| r.to_string_lossy().replace('\\', "/").to_lowercase());

    notes
        .iter()
        .filter_map(|note| {
            // Membership is the folder the file sits in — there's no flag on a
            // note saying it's fleeting, and there shouldn't be: moving it out
            // of Inbox/ in Explorer should file it just as surely as pressing
            // Submit does.
            if q.inbox_only && !is_inbox_note(note) {
                return None;
            }
            if q.inbox_excluded && is_inbox_note(note) {
                return None;
            }
            if needs_folder_path {
                let folder_path = relative_folder_path(note, root_lower.as_deref());
                if q.foldered_only && folder_path.is_empty() {
                    return None;
                }
                if q.root_only && !folder_path.is_empty() {
                    return None;
                }
                if let Some(f) = &q.folder {
                    if !folder_matches(&folder_path, f) {
                        return None;
                    }
                }
                if !q.exclude_folders.is_empty()
                    && q.exclude_folders.iter().any(|f| folder_matches(&folder_path, f))
                {
                    return None;
                }
            }
            if q.image_only && !note.has_image_embed() {
                return None;
            }
            if q.image_excluded && note.has_image_embed() {
                return None;
            }
            if q.embed_only && !note.has_note_embed() {
                return None;
            }
            if q.embed_excluded && note.has_note_embed() {
                return None;
            }
            if let Some(link) = &q.link {
                if !note.wiki_links().contains(link) {
                    return None;
                }
            }
            if !q.exclude_links.is_empty()
                && note.wiki_links().iter().any(|l| q.exclude_links.contains(l))
            {
                return None;
            }
            if let Some(target) = &q.interlink {
                // Connected in either direction, excluding the hub note itself —
                // the footer for X lists X's neighbours, not X.
                let connected = note.wiki_links().iter().any(|l| l == target)
                    || interlink_outbound.contains(note.lowercased_title());
                if !connected || note.lowercased_title() == target {
                    return None;
                }
            }
            if !exclude_interlink_outbound.is_empty() {
                let excluded = exclude_interlink_outbound.iter().any(|(target, outbound)| {
                    note.wiki_links().iter().any(|l| l == target)
                        || outbound.contains(note.lowercased_title())
                });
                if excluded {
                    return None;
                }
            }
            if q.ghost_only || q.ghost_excluded {
                // A ghost link's target answers to no note — an image
                // attachment reference never counts, since it isn't a note.
                let has_ghost = note.wiki_links().iter().any(|target| {
                    !all_note_titles.contains(target.as_str())
                        && !crate::note::is_image_attachment(target)
                });
                if q.ghost_only && !has_ghost {
                    return None;
                }
                if q.ghost_excluded && has_ghost {
                    return None;
                }
            }
            if q.orphan_only || q.linked_only {
                let is_orphan = note.wiki_links().is_empty()
                    && !linked_to_titles.contains(note.lowercased_title());
                if q.orphan_only && !is_orphan {
                    return None;
                }
                if q.linked_only && is_orphan {
                    return None;
                }
            }
            if !q.phrase_terms.is_empty() {
                let (t, c) = (note.lowercased_title(), note.lowercased_content());
                if !q
                    .phrase_terms
                    .iter()
                    .all(|p| whole_word_contains(t, p) || whole_word_contains(c, p))
                {
                    return None;
                }
            }
            if !q.exclude_phrases.is_empty() {
                let (t, c) = (note.lowercased_title(), note.lowercased_content());
                if q
                    .exclude_phrases
                    .iter()
                    .any(|p| whole_word_contains(t, p) || whole_word_contains(c, p))
                {
                    return None;
                }
            }
            if q.todo_only && !note.has_unchecked_task() {
                return None;
            }
            if q.todo_excluded && note.has_unchecked_task() {
                return None;
            }
            if !q.title_terms.is_empty() {
                let title = note.lowercased_title();
                if !q.title_terms.iter().all(|term| fast_contains(title, term)) {
                    return None;
                }
            }
            if !q.exclude_titles.is_empty() {
                let title = note.lowercased_title();
                if q.exclude_titles.iter().any(|term| fast_contains(title, term)) {
                    return None;
                }
            }
            if q.tagged_only && note.tags().is_empty() {
                return None;
            }
            if q.untagged_only && !note.tags().is_empty() {
                return None;
            }
            if let Some(tag) = &q.tag {
                if !note.tags().iter().any(|t| tag_matches(t, tag)) {
                    return None;
                }
            }
            if !q.exclude_tags.is_empty()
                && note
                    .tags()
                    .iter()
                    .any(|t| q.exclude_tags.iter().any(|x| tag_matches(t, x)))
            {
                return None;
            }
            if let Some((start, end)) = q.date {
                let m = modified_datetime(note)?;
                if !(m >= start && m < end) {
                    return None;
                }
            }
            // `stale:` is `date:`'s complement — untouched *since* the cutoff.
            if let Some(cutoff) = q.stale {
                if modified_datetime(note)? >= cutoff {
                    return None;
                }
            }
            if let Some(cutoff) = q.exclude_stale {
                if modified_datetime(note)? < cutoff {
                    return None;
                }
            }
            if q.due_invalid {
                return None;
            }
            if let Some(c) = q.due {
                if !due_condition_matches(c, note, today) {
                    return None;
                }
            }
            if let Some(c) = q.exclude_due {
                if due_condition_matches(c, note, today) {
                    return None;
                }
            }
            if let Some(f) = q.ai {
                if !f.matches(note.ai_provenance()) {
                    return None;
                }
            }
            if let Some(f) = q.exclude_ai {
                if f.matches(note.ai_provenance()) {
                    return None;
                }
            }
            if !q.exclude_terms.is_empty() {
                let (t, c) = (note.lowercased_title(), note.lowercased_content());
                if q
                    .exclude_terms
                    .iter()
                    .any(|x| fast_contains(t, x) || fast_contains(c, x))
                {
                    return None;
                }
            }

            // An operator (or 2+ free terms) combines with whatever else is
            // typed alongside it via "does every term show up somewhere"
            // scoring.
            if has_operator || q.free_terms.len() > 1 {
                return score_by_term_presence(note, &q.free_terms).map(|s| (note, s));
            }
            let Some(term) = q.free_terms.first() else {
                return Some((note, 0));
            };

            // A single free term, no operators — exact/prefix/contains ranking.
            let title = note.lowercased_title();
            let score = if title == term {
                4
            } else if title.starts_with(term.as_str()) {
                3
            } else if fast_contains(title, term) {
                2
            } else if fast_contains(note.lowercased_content(), term) {
                1
            } else {
                return None;
            };
            Some((note, score))
        })
        .collect()
}

/// Higher score first; ties broken by most recently modified.
fn ranked_higher_first(a: &(&Note, i32), b: &(&Note, i32)) -> std::cmp::Ordering {
    b.1.cmp(&a.1).then(b.0.modified.cmp(&a.0.modified))
}

/// `root` is the Index's own directory, needed so `folder:` can resolve a
/// note's path relative to the vault. `None` falls back to matching the
/// immediate parent folder's name — enough for a flat search, and what the
/// tests without a real vault use.
pub fn filtered<'a>(
    notes: &'a [Note],
    query: &str,
    ctx: &SearchContext,
    root: Option<&Path>,
) -> Vec<&'a Note> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return notes.iter().collect();
    }

    let groups = split_groups(trimmed);
    if groups.is_empty() {
        return notes.iter().collect();
    }

    if groups.len() == 1 {
        let mut hits = matched(notes, &groups[0], ctx, root);
        hits.sort_by(ranked_higher_first);
        return hits.into_iter().map(|(n, _)| n).collect();
    }

    // Several groups OR together, each note keeping its best score across the
    // groups that matched it.
    let mut best: HashMap<&str, (&Note, i32)> = HashMap::new();
    for group in &groups {
        for (note, score) in matched(notes, group, ctx, root) {
            best.entry(note.id())
                .and_modify(|e| e.1 = e.1.max(score))
                .or_insert((note, score));
        }
    }
    let mut hits: Vec<(&Note, i32)> = best.into_values().collect();
    hits.sort_by(ranked_higher_first);
    hits.into_iter().map(|(n, _)| n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration as StdDuration, SystemTime};

    /// 2026-07-25 is a Saturday — the same fixture date the due tests use, so
    /// the calendar-week boundary cases stay meaningful here too.
    fn ctx() -> SearchContext {
        SearchContext {
            now: Local.with_ymd_and_hms(2026, 7, 25, 12, 0, 0).unwrap(),
            week_start: Weekday::Sun,
        }
    }

    fn note(title: &str, content: &str) -> Note {
        Note::new(format!("C:/Index/{title}.md"), content, SystemTime::UNIX_EPOCH)
    }

    fn inbox_note(title: &str, content: &str) -> Note {
        Note::new(
            format!("C:/Index/Inbox/{title}.md"),
            content,
            SystemTime::UNIX_EPOCH,
        )
    }

    fn titles(notes: &[Note], query: &str) -> Vec<String> {
        filtered(notes, query, &ctx(), None)
            .into_iter()
            .map(|n| n.title().to_string())
            .collect()
    }

    /// For folder: tests, which need a real Index root to resolve paths
    /// against. `C:/Index` matches the ids the `note` helper builds.
    fn titles_rooted(notes: &[Note], query: &str) -> Vec<String> {
        filtered(notes, query, &ctx(), Some(Path::new("C:/Index")))
            .into_iter()
            .map(|n| n.title().to_string())
            .collect()
    }

    #[test]
    fn single_term_ranks_exact_then_prefix_then_title_then_content() {
        let notes = vec![
            // Title deliberately free of the term, so this can only score on
            // content.
            note("Body mention only", "all about rust really"),
            note("Rustaceans", "community"),
            note("rust", "the exact title"),
            note("Learning rust slowly", "notes"),
        ];
        // exact(4) > prefix(3) > title-contains(2) > content-only(1)
        assert_eq!(
            titles(&notes, "rust"),
            vec![
                "rust",
                "Rustaceans",
                "Learning rust slowly",
                "Body mention only"
            ]
        );
    }

    #[test]
    fn empty_query_returns_everything() {
        let notes = vec![note("A", ""), note("B", "")];
        assert_eq!(titles(&notes, "").len(), 2);
        assert_eq!(titles(&notes, "   ").len(), 2);
    }

    #[test]
    fn tokenize_keeps_quoted_spaces_together() {
        assert_eq!(tokenize("dog \"bone leash\""), vec!["dog", "\"bone leash\""]);
        assert_eq!(
            tokenize("link:\"Meeting Notes\""),
            vec!["link:\"Meeting Notes\""]
        );
    }

    #[test]
    fn closed_quote_is_word_boundary_exact() {
        let notes = vec![note("A", "she was nee Smith"), note("B", "it was needed")];
        // Closed → the word "nee", not the "nee" inside "needed".
        assert_eq!(titles(&notes, "\"nee\""), vec!["A"]);
    }

    #[test]
    fn closed_quote_keeps_scanning_past_a_rejected_hit() {
        // "needed" comes first and fails the boundary check. A scanner that
        // gave up on the first substring hit would miss the real word later on.
        let notes = vec![note("A", "it was needed, she was nee Smith")];
        assert_eq!(titles(&notes, "\"nee\""), vec!["A"]);
    }

    #[test]
    fn closed_quote_handles_multibyte_neighbours() {
        // The rejected-hit rewind advances by a character, not a byte — these
        // would panic on a non-boundary slice otherwise. And é is a letter, so
        // it must block the boundary exactly as an ASCII letter does.
        let notes = vec![
            note("Accent", "the café au lait"),
            note("Glued", "the caférie"),
            note("Emoji", "the 🎈 café 🎈"),
        ];
        let mut got = titles(&notes, "\"café\"");
        got.sort();
        assert_eq!(got, vec!["Accent", "Emoji"]);
    }

    #[test]
    fn closed_quote_matches_at_the_very_start_and_end() {
        let notes = vec![note("Edges", "nee")];
        assert_eq!(titles(&notes, "\"nee\""), vec!["Edges"]);
    }

    #[test]
    fn open_quote_is_a_substring_so_results_appear_while_typing() {
        let notes = vec![note("A", "she was nee Smith"), note("B", "it was needed")];
        let mut got = titles(&notes, "\"nee");
        got.sort();
        assert_eq!(got, vec!["A", "B"]);
    }

    #[test]
    fn phrase_requires_adjacency() {
        let notes = vec![
            note("Together", "a dog bone here"),
            note("Apart", "a dog and a bone"),
        ];
        assert_eq!(titles(&notes, "\"dog bone\""), vec!["Together"]);
        // Unquoted, both words just have to appear somewhere.
        let mut both = titles(&notes, "dog bone");
        both.sort();
        assert_eq!(both, vec!["Apart", "Together"]);
    }

    #[test]
    fn excluded_phrase_removes_matches() {
        let notes = vec![note("Keep", "a dog bone"), note("Drop", "a cat bone")];
        assert_eq!(titles(&notes, "bone -\"cat bone\""), vec!["Keep"]);
    }

    #[test]
    fn tag_filter_and_exclusion() {
        let notes = vec![
            note("Tagged", "about #windows things"),
            note("Other", "about #macos things"),
        ];
        assert_eq!(titles(&notes, "tag:windows"), vec!["Tagged"]);
        assert_eq!(titles(&notes, "-tag:windows"), vec!["Other"]);
    }

    #[test]
    fn todo_filter() {
        let notes = vec![note("Has", "- [ ] a task"), note("None", "- [x] done")];
        assert_eq!(titles(&notes, "todo:"), vec!["Has"]);
        assert_eq!(titles(&notes, "-todo:"), vec!["None"]);
    }

    #[test]
    fn ai_provenance_filter() {
        let notes = vec![
            note("Made", "body\n⎈ created by Claude · 2026-07-25"),
            note("Touched", "body\n⎈ edited by Claude · 2026-07-25"),
            note("Mine", "just me"),
        ];
        let mut any = titles(&notes, "ai:");
        any.sort();
        assert_eq!(any, vec!["Made", "Touched"]);
        assert_eq!(titles(&notes, "ai:created"), vec!["Made"]);
        assert_eq!(titles(&notes, "ai:edited"), vec!["Touched"]);
        assert_eq!(titles(&notes, "-ai:"), vec!["Mine"]);
    }

    #[test]
    fn inbox_scoping() {
        let notes = vec![inbox_note("Fleeting", "captured"), note("Filed", "kept")];
        assert_eq!(titles(&notes, "inbox:"), vec!["Fleeting"]);
        assert_eq!(titles(&notes, "-inbox:"), vec!["Filed"]);
    }

    #[test]
    fn inbox_with_trailing_text_searches_within_fleeting_notes() {
        let notes = vec![
            inbox_note("One", "bauhaus design"),
            inbox_note("Two", "something else"),
            note("Three", "bauhaus filed"),
        ];
        assert_eq!(titles(&notes, "inbox: bauhaus"), vec!["One"]);
    }

    #[test]
    fn link_traversal_and_orphans() {
        let notes = vec![
            note("Source", "see [[Ideas]]"),
            note("Ideas", "the target"),
            note("Adrift", "no links at all"),
        ];
        assert_eq!(titles(&notes, "link:ideas"), vec!["Source"]);
        assert_eq!(titles(&notes, "orphan:"), vec!["Adrift"]);
        let mut linked = titles(&notes, "linked:");
        linked.sort();
        assert_eq!(linked, vec!["Ideas", "Source"]);
    }

    #[test]
    fn link_with_spaces_needs_quotes() {
        let notes = vec![note("Source", "see [[Meeting Notes]]"), note("Other", "x")];
        assert_eq!(titles(&notes, "link:\"Meeting Notes\""), vec!["Source"]);
    }

    #[test]
    fn due_buckets() {
        let notes = vec![
            note("Overdue", "ship it @01-15-26"),
            note("ThisWeek", "review @07-25-26"),
            note("Later", "launch @12-31-26"),
            note("Undated", "nothing due"),
        ];
        assert_eq!(titles(&notes, "due:overdue"), vec!["Overdue"]);
        // "past" is a plain alias for "overdue".
        assert_eq!(titles(&notes, "due:past"), vec!["Overdue"]);
        assert_eq!(titles(&notes, "due:today"), vec!["ThisWeek"]);
        assert_eq!(titles(&notes, "due:week"), vec!["ThisWeek"]);

        let mut any = titles(&notes, "due:");
        any.sort();
        assert_eq!(any, vec!["Later", "Overdue", "ThisWeek"]);

        let mut future = titles(&notes, "due:future");
        future.sort();
        assert_eq!(future, vec!["Later", "ThisWeek"]);
    }

    /// An unrecognized `due:` value matches nothing rather than everything —
    /// "due:cats" isn't a typo of a real bucket, it's invalid, and silently
    /// showing every note would hide that.
    #[test]
    fn invalid_due_value_matches_nothing() {
        let notes = vec![note("A", "due @01-15-26"), note("B", "no due date")];
        assert!(titles(&notes, "due:cats").is_empty());
    }

    /// `date:` takes the opposite fallback deliberately — a typo shows
    /// everything rather than dumping you into a confusing empty list.
    #[test]
    fn invalid_date_value_shows_everything() {
        let notes = vec![note("A", "x"), note("B", "y")];
        assert_eq!(titles(&notes, "date:cats").len(), 2);
    }

    #[test]
    fn due_exclusion() {
        let notes = vec![
            note("Overdue", "ship it @01-15-26"),
            note("Later", "launch @12-31-26"),
        ];
        assert_eq!(titles(&notes, "-due:overdue"), vec!["Later"]);
    }

    #[test]
    fn date_filter_uses_modification_time() {
        let recent = SystemTime::from(ctx().now) - StdDuration::from_secs(60 * 60);
        let old = SystemTime::from(ctx().now) - StdDuration::from_secs(60 * 60 * 24 * 40);
        let notes = vec![
            Note::new("C:/Index/Recent.md", "x", recent),
            Note::new("C:/Index/Old.md", "x", old),
        ];
        assert_eq!(titles(&notes, "date:today"), vec!["Recent"]);
        assert_eq!(titles(&notes, "date:week"), vec!["Recent"]);
    }

    /// Three ages, so every `stale:` period has something on each side of it.
    fn aged_notes() -> Vec<Note> {
        let day = 60 * 60 * 24;
        let at = |days: u64| SystemTime::from(ctx().now) - StdDuration::from_secs(day * days);
        vec![
            Note::new("C:/Index/Fresh.md", "x", at(2)),
            Note::new("C:/Index/Middling.md", "x", at(60)),
            Note::new("C:/Index/Ancient.md", "x", at(400)),
        ]
    }

    #[test]
    fn bare_stale_is_six_months() {
        let notes = aged_notes();
        // 60 days is not yet stale at six months; 400 is.
        assert_eq!(titles(&notes, "stale:"), vec!["Ancient"]);
    }

    #[test]
    fn stale_periods_narrow_the_window() {
        let notes = aged_notes();
        let mut week = titles(&notes, "stale:week");
        week.sort();
        assert_eq!(week, vec!["Ancient", "Middling"]);

        let mut month = titles(&notes, "stale:month");
        month.sort();
        assert_eq!(month, vec!["Ancient", "Middling"]);

        assert_eq!(titles(&notes, "stale:year"), vec!["Ancient"]);
    }

    #[test]
    fn stale_accepts_a_number_of_days() {
        let notes = aged_notes();
        let mut got = titles(&notes, "stale:30");
        got.sort();
        assert_eq!(got, vec!["Ancient", "Middling"]);
        // The trailing "d" is the same question.
        let mut with_d = titles(&notes, "stale:30d");
        with_d.sort();
        assert_eq!(with_d, got);
        assert_eq!(titles(&notes, "stale:365"), vec!["Ancient"]);
    }

    #[test]
    fn stale_exclusion_keeps_the_recently_touched() {
        let notes = aged_notes();
        assert_eq!(titles(&notes, "-stale:year"), vec!["Fresh", "Middling"]);
    }

    /// Follows `date:` rather than `due:`: an unrecognized period is a typo, and
    /// showing everything beats an unexplained empty list.
    #[test]
    fn invalid_stale_value_shows_everything() {
        let notes = aged_notes();
        assert_eq!(titles(&notes, "stale:cats").len(), 3);
        assert_eq!(titles(&notes, "stale:0").len(), 3);
    }

    /// The pairing the release notes single out: disconnected *and* forgotten.
    #[test]
    fn stale_composes_with_orphan() {
        let day = 60 * 60 * 24;
        let at = |days: u64| SystemTime::from(ctx().now) - StdDuration::from_secs(day * days);
        let notes = vec![
            Note::new("C:/Index/Old Orphan.md", "nothing links here", at(400)),
            Note::new("C:/Index/Old Linked.md", "see [[Hub]]", at(400)),
            Note::new("C:/Index/Fresh Orphan.md", "alone", at(1)),
        ];
        assert_eq!(titles(&notes, "orphan: stale:"), vec!["Old Orphan"]);
    }

    #[test]
    fn bare_exclusion_term() {
        let notes = vec![note("Keep", "apples"), note("Drop", "apples and oranges")];
        assert_eq!(titles(&notes, "apples -oranges"), vec!["Keep"]);
    }

    #[test]
    fn comma_groups_are_or_ed() {
        let notes = vec![
            note("Dog", "a dog"),
            note("Cat", "a cat"),
            note("Fish", "a fish"),
        ];
        let mut got = titles(&notes, "dog, cat");
        got.sort();
        assert_eq!(got, vec!["Cat", "Dog"]);
    }

    #[test]
    fn within_a_group_terms_are_and_ed() {
        let notes = vec![note("Both", "a dog and a cat"), note("One", "a dog only")];
        assert_eq!(titles(&notes, "dog cat"), vec!["Both"]);
    }

    /// Combining several has ambiguous AND-vs-OR semantics, so the later one
    /// is ignored rather than guessed at — comma groups are what OR is for.
    #[test]
    fn only_the_first_tag_of_a_polarity_is_honored() {
        let notes = vec![note("A", "#one #two"), note("B", "#two only")];
        assert_eq!(titles(&notes, "tag:one tag:two"), vec!["A"]);
    }

    #[test]
    fn every_exclusion_is_honored_not_just_the_first() {
        let notes = vec![
            note("Keep", "#keep"),
            note("DropA", "#dropa"),
            note("DropB", "#dropb"),
        ];
        assert_eq!(titles(&notes, "-tag:dropa -tag:dropb"), vec!["Keep"]);
    }

    // --- 1.8.x operators ----------------------------------------------------

    /// A note filed in `Projects/Work` — the `note` helper only makes root
    /// notes, so folder tests build their own paths under `C:/Index`.
    fn note_in(folder: &str, title: &str, content: &str) -> Note {
        Note::new(
            format!("C:/Index/{folder}/{title}.md"),
            content,
            SystemTime::UNIX_EPOCH,
        )
    }

    #[test]
    fn folder_matches_partial_and_by_any_segment() {
        let notes = vec![
            note("Root", "x"),
            note_in("Projects", "A", "x"),
            note_in("Projects/Work", "B", "x"),
            note_in("Archive", "C", "x"),
        ];
        // Partial, case-insensitive, against the whole relative path.
        let mut got = titles_rooted(&notes, "folder:proj");
        got.sort();
        assert_eq!(got, vec!["A", "B"]);
        // Findable by a nested segment.
        assert_eq!(titles_rooted(&notes, "folder:work"), vec!["B"]);
    }

    #[test]
    fn folder_quoted_is_exact_or_descendant() {
        let notes = vec![
            note_in("Work", "A", "x"),
            note_in("Work/Deep", "B", "x"),
            note_in("Workshop", "C", "x"),
        ];
        // Bare "work" is a substring match — it also catches Workshop.
        let mut bare = titles_rooted(&notes, "folder:work");
        bare.sort();
        assert_eq!(bare, vec!["A", "B", "C"]);
        // Quoted demands exactness: Work and its descendants, never Workshop.
        let mut exact = titles_rooted(&notes, "folder:\"work\"");
        exact.sort();
        assert_eq!(exact, vec!["A", "B"]);
    }

    #[test]
    fn bare_folder_is_anything_nested_and_minus_folder_is_the_root() {
        let notes = vec![
            note("AtRoot", "x"),
            note_in("Projects", "Nested", "x"),
        ];
        assert_eq!(titles_rooted(&notes, "folder:"), vec!["Nested"]);
        assert_eq!(titles_rooted(&notes, "-folder:"), vec!["AtRoot"]);
    }

    #[test]
    fn tag_quoted_is_exact() {
        let notes = vec![note("A", "#tag"), note("B", "#tags")];
        // Bare partial catches both.
        let mut bare = titles(&notes, "tag:tag");
        bare.sort();
        assert_eq!(bare, vec!["A", "B"]);
        // Quoted matches only the exact tag.
        assert_eq!(titles(&notes, "tag:\"tag\""), vec!["A"]);
    }

    #[test]
    fn bare_tag_is_any_tagged_and_minus_tag_is_untagged() {
        let notes = vec![note("Tagged", "#x here"), note("Plain", "no tags")];
        assert_eq!(titles(&notes, "tag:"), vec!["Tagged"]);
        assert_eq!(titles(&notes, "-tag:"), vec!["Plain"]);
    }

    #[test]
    fn title_matches_titles_only_not_bodies() {
        let notes = vec![
            note("Rust guide", "nothing relevant"),
            note("Other", "a long note about rust internals"),
        ];
        // Plain search would match both; title: only the one named for it.
        assert_eq!(titles(&notes, "title:rust"), vec!["Rust guide"]);
        // Several title: terms AND together.
        assert_eq!(titles(&notes, "title:rust title:guide"), vec!["Rust guide"]);
        // -title: excludes.
        assert_eq!(titles(&notes, "rust -title:guide"), vec!["Other"]);
    }

    #[test]
    fn interlink_connects_in_both_directions() {
        let notes = vec![
            note("Hub", "links to [[Downstream]]"),
            note("Upstream", "points at [[Hub]]"),
            note("Downstream", "leaf"),
            note("Unrelated", "nothing"),
        ];
        // Both the note linking *to* Hub and the note Hub links *out* to,
        // excluding Hub itself.
        let mut got = titles(&notes, "interlink:Hub");
        got.sort();
        assert_eq!(got, vec!["Downstream", "Upstream"]);
    }

    #[test]
    fn interlink_degrades_to_inbound_when_target_absent() {
        let notes = vec![note("A", "see [[Ghost]]"), note("B", "unrelated")];
        // No note named Ghost, so only the inbound half survives.
        assert_eq!(titles(&notes, "interlink:Ghost"), vec!["A"]);
    }

    #[test]
    fn ghost_finds_unresolved_links_only() {
        let notes = vec![
            note("Keeper", "see [[Real]]"),
            note("Real", "exists"),
            note("Promiser", "see [[Nonexistent]]"),
        ];
        assert_eq!(titles(&notes, "ghost:"), vec!["Promiser"]);
        // -ghost: is the complement: notes whose links all resolve. "Real" has
        // no links at all, which also counts as "nothing unresolved".
        let mut resolved = titles(&notes, "-ghost:");
        resolved.sort();
        assert_eq!(resolved, vec!["Keeper", "Real"]);
    }

    #[test]
    fn ghost_ignores_image_embeds() {
        // An image target is not a note, so it must not read as a ghost link.
        let notes = vec![note("HasImage", "![[diagram.png]] and text")];
        assert!(titles(&notes, "ghost:").is_empty());
    }

    #[test]
    fn img_and_embed_tell_the_two_kinds_apart() {
        let notes = vec![
            note("Picture", "![[photo.jpg]]"),
            note("Transclusion", "![[Another Note]]"),
            note("Plain", "no embeds"),
        ];
        assert_eq!(titles(&notes, "img:"), vec!["Picture"]);
        assert_eq!(titles(&notes, "embed:"), vec!["Transclusion"]);
        assert!(!titles(&notes, "-img:").contains(&"Picture".to_string()));
    }

    #[test]
    fn comma_inside_a_quoted_argument_does_not_split_the_query() {
        let notes = vec![
            note("Debrief (Sep 24, 2025)", "the hub"),
            note("Linker", "see [[Debrief (Sep 24, 2025)]]"),
            note("Unrelated", "x"),
        ];
        // The comma is inside the quotes, so this is one interlink: group, not
        // two OR groups. Under the old naive split it fell apart.
        assert_eq!(
            titles(&notes, "interlink:\"Debrief (Sep 24, 2025)\""),
            vec!["Linker"]
        );
    }
}
