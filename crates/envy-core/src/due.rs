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

/// Not-yet-due, due-soon (within the coming week), and overdue are three
/// separate theme tokens rather than one color with urgency layered on top.
/// Urgency only decides *which* slot applies, never overrides what's in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DueUrgency {
    Normal,
    Soon,
    Overdue,
}

pub fn urgency_for(date: NaiveDate, today: NaiveDate) -> DueUrgency {
    if date < today {
        DueUrgency::Overdue
    } else if date < today + Duration::days(7) {
        DueUrgency::Soon
    } else {
        DueUrgency::Normal
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

    #[test]
    fn urgency_buckets() {
        let today = d(2026, 7, 25);
        assert_eq!(urgency_for(d(2026, 7, 24), today), DueUrgency::Overdue);
        assert_eq!(urgency_for(today, today), DueUrgency::Soon);
        assert_eq!(urgency_for(d(2026, 7, 31), today), DueUrgency::Soon);
        assert_eq!(urgency_for(d(2026, 8, 1), today), DueUrgency::Normal);
    }
}
