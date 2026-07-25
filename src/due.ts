// Port of NoteStore.resolveDueToken + Note.activeDueDates' retirement rules.
// Kept in its own module because this logic belongs in envy-core (Rust) for
// real — it's here only so the spike can prove the *rendering* half against
// correct dates rather than hardcoded ones.

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/// A day name always means the *next* occurrence of that day — matching
/// NoteStore.resolveDueToken. Absolute forms are "MM-DD-YY", "MM/DD/YY", and
/// "YYYY-MM-DD". An unparseable token returns null, which just means no due
/// date — the same forgiving failure mode as a malformed tag or wiki-link,
/// never a throw.
export function resolveDueToken(token: string, now = new Date()): Date | null {
  const t = token.toLowerCase()
  const today = startOfDay(now)

  if (t === 'today') return today
  if (t === 'tomorrow') return new Date(today.getTime() + 86400000)
  if (t === 'yesterday') return new Date(today.getTime() - 86400000)

  const weekdayIndex = WEEKDAYS.indexOf(t)
  if (weekdayIndex >= 0) {
    // "Next occurrence" — never today itself, so @monday typed on a Monday
    // means the Monday a week out, not this morning.
    let delta = (weekdayIndex - today.getDay() + 7) % 7
    if (delta === 0) delta = 7
    return new Date(today.getTime() + delta * 86400000)
  }

  const parts = t.split(/[-/]/).filter((p) => p.length > 0)
  if (parts.length !== 3) return null
  const nums = parts.map((p) => Number.parseInt(p, 10))
  if (nums.some((n) => Number.isNaN(n))) return null

  let year: number, month: number, day: number
  if (parts[0].length === 4) {
    // YYYY-MM-DD
    ;[year, month, day] = nums
  } else {
    // MM-DD-YY (or MM-DD-YYYY)
    ;[month, day, year] = nums
    if (parts[2].length <= 2) year += 2000
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const date = new Date(year, month - 1, day)
  // Reject rollover ("02-31-26" would otherwise silently become March 3).
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

export type DueUrgency = 'later' | 'soon' | 'overdue'

/// Three separate tokens rather than one color with urgency logic layered on
/// top — see Theme.swift's comment on dueColor. Urgency only decides *which*
/// slot applies, never overrides what's in it.
///
/// "Soon" is the **current calendar week**, deliberately the exact window
/// `due:week` resolves to — not a rolling seven days. That matters in both
/// directions: it includes days earlier this week that have already passed,
/// and excludes days within seven days that fall into next week. A due-soon
/// color that disagreed with what `due:week` returned would be its own
/// confusing bug. This must stay in step with `urgency_for` in envy-core.
///
/// `weekStart` is 0 (Sunday) or 1 (Monday) — locale-dependent, so it is a
/// parameter rather than a constant.
export function urgencyFor(date: Date, now = new Date(), weekStart = 0): DueUrgency {
  const today = startOfDay(now)
  if (date.getTime() < today.getTime()) return 'overdue'
  // Last day of the current calendar week, inclusive.
  const daysIntoWeek = (today.getDay() - weekStart + 7) % 7
  const weekEnd = new Date(today.getTime() + (6 - daysIntoWeek) * 86400000)
  return date.getTime() <= weekEnd.getTime() ? 'soon' : 'later'
}
