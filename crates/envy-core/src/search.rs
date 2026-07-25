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

use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Weekday};
use fancy_regex::Regex;

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

fn fast_contains(haystack: &str, needle: &str) -> bool {
    haystack.contains(needle)
}

/// Compiled once per query rather than per note. The Swift builds this regex
/// inside the per-note predicate, which recompiles it for every note in the
/// Index on every keystroke; hoisting it is a pure win with no behavior change.
fn whole_word_regex(phrase: &str) -> Option<Regex> {
    let pattern = format!(
        r"(?i)(?<![\p{{L}}\p{{N}}_]){}(?![\p{{L}}\p{{N}}_])",
        fancy_regex::escape(phrase)
    );
    Regex::new(&pattern).ok()
}

fn whole_word_matches(re: &Regex, haystack: &str) -> bool {
    re.find(haystack).ok().flatten().is_some()
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

#[derive(Default)]
struct GroupQuery {
    tag: Option<String>,
    exclude_tags: Vec<String>,
    date: Option<(DateTime<Local>, DateTime<Local>)>,
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
    phrase_terms: Vec<Regex>,
    exclude_phrases: Vec<Regex>,
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
            || self.date.is_some()
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
            } else if let Some(rest) = t.strip_prefix("-ai:") {
                if q.exclude_ai.is_none() {
                    q.exclude_ai = AiFilter::parse(rest);
                }
            } else if let Some(rest) = t.strip_prefix("ai:") {
                if q.ai.is_none() {
                    q.ai = AiFilter::parse(rest);
                }
            } else if let Some(rest) = t.strip_prefix("-tag:") {
                if !rest.is_empty() {
                    q.exclude_tags.push(rest.to_string());
                }
            } else if let Some(rest) = t.strip_prefix("tag:") {
                if q.tag.is_none() && !rest.is_empty() {
                    q.tag = Some(rest.to_string());
                }
            } else if let Some(rest) = t.strip_prefix("date:") {
                if q.date.is_none() {
                    q.date = date_range(rest, ctx);
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
            } else if t == "linked:" {
                q.linked_only = true;
            } else if t == "orphan:" {
                q.orphan_only = true;
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
                        if let Some(re) = whole_word_regex(&phrase) {
                            q.exclude_phrases.push(re);
                        }
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
                        if let Some(re) = whole_word_regex(&phrase) {
                            q.phrase_terms.push(re);
                        }
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

fn matched<'a>(notes: &'a [Note], group: &str, ctx: &SearchContext) -> Vec<(&'a Note, i32)> {
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
                    .all(|re| whole_word_matches(re, t) || whole_word_matches(re, c))
                {
                    return None;
                }
            }
            if !q.exclude_phrases.is_empty() {
                let (t, c) = (note.lowercased_title(), note.lowercased_content());
                if q
                    .exclude_phrases
                    .iter()
                    .any(|re| whole_word_matches(re, t) || whole_word_matches(re, c))
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
            if let Some(tag) = &q.tag {
                if !note.tags().iter().any(|t| fast_contains(t, tag)) {
                    return None;
                }
            }
            if !q.exclude_tags.is_empty()
                && note
                    .tags()
                    .iter()
                    .any(|t| q.exclude_tags.iter().any(|x| fast_contains(t, x)))
            {
                return None;
            }
            if let Some((start, end)) = q.date {
                let m = modified_datetime(note)?;
                if !(m >= start && m < end) {
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

pub fn filtered<'a>(notes: &'a [Note], query: &str, ctx: &SearchContext) -> Vec<&'a Note> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return notes.iter().collect();
    }

    let groups: Vec<&str> = trimmed
        .split(',')
        .map(|g| g.trim())
        .filter(|g| !g.is_empty())
        .collect();
    if groups.is_empty() {
        return notes.iter().collect();
    }

    if groups.len() == 1 {
        let mut hits = matched(notes, groups[0], ctx);
        hits.sort_by(ranked_higher_first);
        return hits.into_iter().map(|(n, _)| n).collect();
    }

    // Several groups OR together, each note keeping its best score across the
    // groups that matched it.
    let mut best: HashMap<&str, (&Note, i32)> = HashMap::new();
    for group in groups {
        for (note, score) in matched(notes, group, ctx) {
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
        filtered(notes, query, &ctx())
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
}
