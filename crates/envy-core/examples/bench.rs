//! Times the operations that happen on a keystroke, against a real vault.
//!
//! Run with: cargo run --release --example bench -- "<path to a vault>"
//!
//! Release only. A debug build measures the absence of optimisation, not the
//! code — the regex engine and the parallel scan are both several times slower
//! without it, and a number from a debug run would be misleading in the
//! direction that makes you fix the wrong thing.

use std::time::Instant;

use envy_core::{interlinks_for, NoteStore, SearchContext};

fn time<T>(label: &str, iterations: u32, mut f: impl FnMut() -> T) -> T {
    // One warm run first, so the figure reflects steady state rather than
    // whatever the first call had to fault in.
    let mut last = f();
    let start = Instant::now();
    for _ in 0..iterations {
        last = f();
    }
    let per = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iterations);
    println!("{label:<44} {per:>8.2} ms");
    last
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"D:\Documents\Envy Benchmark".to_string());

    println!("vault: {dir}\n");

    let start = Instant::now();
    let mut store = NoteStore::open(&dir, false).expect("open the vault");
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!("{:<44} {open_ms:>8.2} ms", "cold open (scan + read every file)");
    println!("notes: {}\n", store.notes().len());

    time("reload (warm, OS cache hot)", 5, || store.reload());

    let ctx = SearchContext::now();
    let notes = store.notes();

    println!();
    for query in [
        "",
        "press",
        "bauhaus",
        "the quick brown",
        "\"deckle edge\"",
        "tag:design",
        "-tag:draft",
        "due:overdue",
        "due:week",
        "todo:",
        "link:\"Bauhaus Notes 0000\"",
        "orphan:",
        "ai:created",
        "inbox:",
        "folder:",
        "ghost:",
        "title:notes",
        "press, ink, paper",
    ] {
        let label = if query.is_empty() { "(empty query)" } else { query };
        time(&format!("search {label:?}"), 20, || {
            envy_core::filtered(notes, query, &ctx, Some(std::path::Path::new(&dir))).len()
        });
    }

    println!();
    // The footer computes this for whichever note is open, so it runs on every
    // note switch — and "suggested" scans the whole corpus for mentions.
    let hub = notes
        .iter()
        .max_by_key(|n| n.wiki_links().len())
        .expect("a note");
    println!(
        "interlinks target: {:?} ({} outgoing links)",
        hub.title(),
        hub.wiki_links().len()
    );
    time("interlinks (links + backlinks + suggested)", 5, || {
        let r = interlinks_for(hub, notes);
        r.count()
    });

    println!();
    // Derived values are cached per note, so the first touch is the expensive
    // one. This is what a cold search pays.
    //
    // Deliberately NOT run through `time()`: that does an untimed warm-up call
    // before it starts the clock, which for a memoized value means it measures
    // the cached second touch. It reported 0.05 ms for work that actually costs
    // ~120 ms. Each of these gets its own store so the caches are genuinely
    // cold, and each is measured once, because there is only ever one first
    // touch.
    let once = |label: &str, f: &dyn Fn(&NoteStore) -> usize| {
        let fresh = NoteStore::open(&dir, false).expect("reopen");
        let start = Instant::now();
        let n = f(&fresh);
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        println!("{label:<44} {ms:>8.2} ms  ({n})");
    };
    once("first touch: lowercased content", &|s| {
        s.notes().iter().map(|n| n.lowercased_content().len()).sum()
    });
    once("first touch: tags", &|s| {
        s.notes().iter().map(|n| n.tags().len()).sum()
    });
    once("first touch: due dates", &|s| {
        s.notes().iter().filter(|n| n.due().is_some()).count()
    });
    once("first touch: previews (the list body)", &|s| {
        s.notes().iter().map(|n| n.preview().len()).sum()
    });
}
