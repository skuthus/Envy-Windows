//! Port of `NoteStore.resolveDueToken` / `parseFlexibleDate` / `nextDate`.

use chrono::{Datelike, Duration, NaiveDate, Weekday};

/// Resolves one `@…` token to a date, or `None` if it isn't a date at all.
///
/// `today` is passed in rather than read from the clock so this stays a pure
/// function — the Swift original calls `Date()` internally, which makes its
/// weekday branch untestable without freezing system time.
///
/// A day name always means the *next* occurrence of that day, never today
/// itself. Everything else relative ("next week", arbitrary phrases) is
/// deliberately handled in the editor as a type-time transform that freezes
/// into a literal absolute date before it's ever saved — see the 1.5.0
/// release note. This function only sees what's actually on disk.
pub fn resolve_due_token(token: &str, today: NaiveDate) -> Option<NaiveDate> {
    let lowered = token.to_lowercase();

    match lowered.as_str() {
        "today" => return Some(today),
        "tomorrow" => return Some(today + Duration::days(1)),
        "yesterday" => return Some(today - Duration::days(1)),
        _ => {}
    }

    if let Some(weekday) = weekday_by_name(&lowered) {
        return Some(next_date(weekday, today));
    }

    parse_flexible_date(token)
}

fn weekday_by_name(name: &str) -> Option<Weekday> {
    Some(match name {
        "sunday" => Weekday::Sun,
        "monday" => Weekday::Mon,
        "tuesday" => Weekday::Tue,
        "wednesday" => Weekday::Wed,
        "thursday" => Weekday::Thu,
        "friday" => Weekday::Fri,
        "saturday" => Weekday::Sat,
        _ => return None,
    })
}

/// Offset 0 becomes 7 — so `@monday` typed on a Monday means the Monday a week
/// out, not this morning. Matches `nextDate(forWeekday:after:)`.
fn next_date(weekday: Weekday, today: NaiveDate) -> NaiveDate {
    let current = today.weekday().num_days_from_sunday() as i64;
    let target = weekday.num_days_from_sunday() as i64;
    let mut offset = (target - current + 7) % 7;
    if offset == 0 {
        offset = 7;
    }
    today + Duration::days(offset)
}

/// `MM-DD-YY`, `MM/DD/YY`, `MM-DD-YYYY`, or `YYYY-MM-DD` — four digits in the
/// first position means it leads with the year, otherwise it's month-first and
/// a two-digit year is assumed to be 20xx.
///
/// Out-of-range *days* roll over rather than failing: `@02-31-26` resolves to
/// March 3rd, not `None`. That is not a considered design choice so much as
/// what Foundation's `Calendar.date(from:)` does by default on the Mac side,
/// and it is reproduced deliberately — a note's due date has to read the same
/// on both platforms, and "the Windows build silently disagrees about what
/// `@02-31-26` means" is a far worse bug than the odd rollover itself. The
/// month range is still validated, exactly as `parseFlexibleDate` validates it.
pub fn parse_flexible_date(input: &str) -> Option<NaiveDate> {
    let parts: Vec<&str> = input
        .split(|c| c == '-' || c == '/')
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() != 3 {
        return None;
    }
    let a: i32 = parts[0].parse().ok()?;
    let b: i32 = parts[1].parse().ok()?;
    let c: i32 = parts[2].parse().ok()?;

    let (year, month, day) = if parts[0].len() == 4 {
        (a, b, c)
    } else {
        (if c < 100 { 2000 + c } else { c }, a, b)
    };

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // Build the 1st and add (day - 1) so an over-long day rolls into the next
    // month the way Foundation's lenient conversion does.
    let first = NaiveDate::from_ymd_opt(year, month as u32, 1)?;
    Some(first + Duration::days((day - 1) as i64))
}

/// Overdue, due-soon, and later are three separate theme tokens rather than
/// one color with urgency layered on top. Urgency only decides *which* slot
/// applies, never overrides what's in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DueUrgency {
    Overdue,
    Soon,
    Later,
}

/// Which day a week starts on. `Calendar.current` on the Mac side resolves
/// this from the user's locale (Sunday in en-US, Monday across most of
/// Europe), so it is a parameter here rather than a constant — the Windows
/// build will read it from the OS the same way, and hardcoding Sunday would
/// silently shift every "this week" boundary for a large share of users.
pub const DEFAULT_WEEK_START: Weekday = Weekday::Sun;

/// Buckets a due date for coloring.
///
/// "Soon" is the **current calendar week**, deliberately the exact window
/// `due:week` resolves to — not a rolling seven days from now. That matters in
/// both directions: it includes days earlier this week that have already
/// passed (an overdue Tuesday task still reads as "due this week" on
/// Wednesday), and it excludes days that are within seven days but fall into
/// next week. A due-soon color that disagreed with what `due:week` actually
/// returned would be its own confusing bug.
pub fn urgency_for(date: NaiveDate, today: NaiveDate, week_start: Weekday) -> DueUrgency {
    if date < today {
        return DueUrgency::Overdue;
    }
    // `last_day()` is inclusive, matching Swift's exclusive `interval.end`
    // compared with `<`.
    if date <= today.week(week_start).last_day() {
        DueUrgency::Soon
    } else {
        DueUrgency::Later
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn relative_tokens() {
        let today = d(2026, 7, 25); // a Saturday
        assert_eq!(resolve_due_token("today", today), Some(today));
        assert_eq!(resolve_due_token("tomorrow", today), Some(d(2026, 7, 26)));
        assert_eq!(resolve_due_token("yesterday", today), Some(d(2026, 7, 24)));
    }

    #[test]
    fn weekday_never_resolves_to_today() {
        let saturday = d(2026, 7, 25);
        // Saturday asked for "saturday" means a week out, not today.
        assert_eq!(resolve_due_token("saturday", saturday), Some(d(2026, 8, 1)));
        assert_eq!(resolve_due_token("monday", saturday), Some(d(2026, 7, 27)));
    }

    #[test]
    fn absolute_forms() {
        let today = d(2026, 7, 25);
        assert_eq!(resolve_due_token("04-16-26", today), Some(d(2026, 4, 16)));
        assert_eq!(resolve_due_token("04/16/26", today), Some(d(2026, 4, 16)));
        assert_eq!(resolve_due_token("2026-04-16", today), Some(d(2026, 4, 16)));
        assert_eq!(resolve_due_token("04-16-2026", today), Some(d(2026, 4, 16)));
    }

    #[test]
    fn rejects_non_dates() {
        let today = d(2026, 7, 25);
        assert_eq!(resolve_due_token("nonsense", today), None);
        assert_eq!(resolve_due_token("13-01-26", today), None); // month 13
        assert_eq!(resolve_due_token("04-16", today), None); // only two parts
    }

    /// Documents the rollover described on `parse_flexible_date` — this test
    /// exists to catch someone "fixing" it into a `None` and silently diverging
    /// from the Mac build.
    #[test]
    fn overlong_day_rolls_over_like_foundation() {
        let today = d(2026, 7, 25);
        assert_eq!(resolve_due_token("02-31-26", today), Some(d(2026, 3, 3)));
    }

    /// 2026-07-25 is a Saturday, so with a Sunday-start week the current week
    /// runs Sun 19th → Sat 25th. That makes today the *last* day of the week,
    /// which is exactly the case a rolling-7-days implementation gets wrong:
    /// Sunday the 26th is one day away but belongs to next week.
    #[test]
    fn soon_is_the_calendar_week_not_a_rolling_seven_days() {
        let saturday = d(2026, 7, 25);
        let w = DEFAULT_WEEK_START;

        assert_eq!(urgency_for(d(2026, 7, 24), saturday, w), DueUrgency::Overdue);
        assert_eq!(urgency_for(saturday, saturday, w), DueUrgency::Soon);
        // One day out, but into next week — "later", not "soon".
        assert_eq!(urgency_for(d(2026, 7, 26), saturday, w), DueUrgency::Later);
    }

    /// The other half of the same rule: mid-week, everything through Saturday
    /// is "soon", including days already past (they're overdue, which takes
    /// precedence, but the week boundary itself still ends Saturday).
    #[test]
    fn soon_spans_to_the_end_of_the_current_week() {
        let wednesday = d(2026, 7, 22);
        let w = DEFAULT_WEEK_START;

        assert_eq!(urgency_for(d(2026, 7, 25), wednesday, w), DueUrgency::Soon);
        assert_eq!(urgency_for(d(2026, 7, 26), wednesday, w), DueUrgency::Later);
        // Earlier this week, already passed — overdue wins over the week test.
        assert_eq!(urgency_for(d(2026, 7, 21), wednesday, w), DueUrgency::Overdue);
    }

    /// A Monday-start locale shifts the boundary. Hardcoding Sunday would put
    /// this a full day off for most of Europe.
    #[test]
    fn week_start_is_locale_dependent() {
        let saturday = d(2026, 7, 25);
        // Monday-start: the week runs Mon 20th → Sun 26th, so the 26th is in.
        assert_eq!(
            urgency_for(d(2026, 7, 26), saturday, Weekday::Mon),
            DueUrgency::Soon
        );
        assert_eq!(
            urgency_for(d(2026, 7, 27), saturday, Weekday::Mon),
            DueUrgency::Later
        );
    }
}
