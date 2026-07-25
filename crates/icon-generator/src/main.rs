//! Port of `Sources/IconGenerator/main.swift`.
//!
//! Draws the "Low Arc" app icon: a lowered red brow over a cream almond eye
//! with a green iris, on warm charcoal. Five flat shapes — no gradient, bevel,
//! shadow or texture — which is what lets it survive to 16px.
//!
//! Geometry is authored in a 512-unit square (the same coordinates as the
//! design's SVG) and scaled to whatever pixel size is requested, so there is
//! one source of truth for the shapes at every size.
//!
//! **Axis note.** The Swift version converts the design's top-down SVG y-axis
//! to AppKit's bottom-up one on the way in. tiny-skia is top-down like SVG, so
//! this file uses the design's *original* coordinates and performs no flip.
//! Comparing the two side by side, every y here is `512 - y_swift`.
//!
//! Usage: icon-generator <output-dir>

use std::path::{Path, PathBuf};

use tiny_skia::{
    Color, FillRule, LineCap, Paint, PathBuilder, Pixmap, Stroke, Transform,
};

const UNIT: f32 = 512.0;

// --- Palette -----------------------------------------------------------------

const FIELD: (u8, u8, u8) = (0x28, 0x25, 0x20);
const BROW: (u8, u8, u8) = (0xFF, 0x4B, 0x39);
const SCLERA: (u8, u8, u8) = (0xFA, 0xFA, 0xF8);
const IRIS: (u8, u8, u8) = (0x30, 0xD1, 0x58);

fn paint(rgb: (u8, u8, u8)) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(Color::from_rgba8(rgb.0, rgb.1, rgb.2, 255));
    p.anti_alias = true;
    p
}

/// Small sizes aren't a straight downscale. Below ~32px a 58-unit stroke lands
/// under two pixels and antialiasing eats it, the gap between brow and eye
/// closes up, and the pupil stops being a hole and becomes grey mush. So the
/// brow thickens and lifts, the iris grows, and the pupil is dropped entirely
/// once it can't render as a distinct shape.
///
/// This is the reason this program exists rather than one master PNG resized
/// by a bundler: a downscale cannot make these decisions.
struct Tuning {
    brow_width: f32,
    brow_lift: f32,
    iris_radius: f32,
    draws_pupil: bool,
}

impl Tuning {
    fn for_pixel_size(px: u32) -> Self {
        if px <= 16 {
            Tuning { brow_width: 70.0, brow_lift: 14.0, iris_radius: 80.0, draws_pupil: false }
        } else if px <= 32 {
            Tuning { brow_width: 64.0, brow_lift: 10.0, iris_radius: 76.0, draws_pupil: true }
        } else {
            Tuning { brow_width: 58.0, brow_lift: 0.0, iris_radius: 70.0, draws_pupil: true }
        }
    }
}

/// The macOS icon corner proportion, kept so the mark reads as the same brand
/// on both platforms. Windows imposes no mask of its own, so this is purely a
/// design choice rather than a platform requirement — pass 0.0 for a square
/// field if the rounded rect ever looks too Mac-ish in the taskbar.
const CORNER_FRACTION: f32 = 0.2237;

fn rounded_rect(size: f32, radius: f32) -> tiny_skia::Path {
    let mut pb = PathBuilder::new();
    if radius <= 0.0 {
        pb.push_rect(tiny_skia::Rect::from_xywh(0.0, 0.0, size, size).unwrap());
        return pb.finish().unwrap();
    }
    // Circular corner arcs approximated with cubics — the Swift uses a plain
    // circular arc too, not Apple's continuous curve, so it reads a touch
    // tighter than a system-drawn one.
    let k = radius * 0.552_284_75;
    let (a, b) = (radius, size - radius);
    pb.move_to(a, 0.0);
    pb.line_to(b, 0.0);
    pb.cubic_to(b + k, 0.0, size, a - k, size, a);
    pb.line_to(size, b);
    pb.cubic_to(size, b + k, b + k, size, b, size);
    pb.line_to(a, size);
    pb.cubic_to(a - k, size, 0.0, b + k, 0.0, b);
    pb.line_to(0.0, a);
    pb.cubic_to(0.0, a - k, a - k, 0.0, a, 0.0);
    pb.close();
    pb.finish().unwrap()
}

fn render(px: u32) -> Pixmap {
    let t = Tuning::for_pixel_size(px);
    let mut pixmap = Pixmap::new(px, px).expect("non-zero icon size");
    let scale = px as f32 / UNIT;
    let tf = Transform::from_scale(scale, scale);

    // Field.
    pixmap.fill_path(
        &rounded_rect(UNIT, UNIT * CORNER_FRACTION),
        &paint(FIELD),
        FillRule::Winding,
        tf,
        None,
    );

    // Brow: a stroked arc with round caps, so it holds an even thickness the
    // whole way. An outlined crescent would taper to nothing at its ends —
    // exactly where the small sizes lose it first.
    let lift = t.brow_lift;
    let mut pb = PathBuilder::new();
    pb.move_to(84.0, 182.0 - lift);
    pb.quad_to(256.0, 96.0 - lift, 428.0, 182.0 - lift);
    let brow_path = pb.finish().expect("brow path");
    pixmap.stroke_path(
        &brow_path,
        &paint(BROW),
        &Stroke { width: t.brow_width, line_cap: LineCap::Round, ..Stroke::default() },
        tf,
        None,
    );

    // Almond: two quadratic curves meeting at a point. This shape is
    // structural, not decoration — it's the only thing keeping the red and the
    // green from sharing an edge, and complementaries that touch shimmer.
    let mut pb = PathBuilder::new();
    pb.move_to(40.0, 290.0);
    pb.quad_to(256.0, 110.0, 472.0, 290.0);
    pb.quad_to(256.0, 470.0, 40.0, 290.0);
    pb.close();
    pixmap.fill_path(&pb.finish().expect("almond"), &paint(SCLERA), FillRule::Winding, tf, None);

    // Iris.
    let (cx, cy) = (256.0_f32, 290.0_f32);
    let circle = |r: f32| {
        PathBuilder::from_circle(cx, cy, r).expect("circle")
    };
    pixmap.fill_path(&circle(t.iris_radius), &paint(IRIS), FillRule::Winding, tf, None);

    // Pupil is the field colour, not a separate black — it reads as a hole
    // punched through to the background rather than as a sixth shape, which is
    // also why changing the field doesn't flatten the eye.
    if t.draws_pupil {
        pixmap.fill_path(&circle(28.0), &paint(FIELD), FillRule::Winding, tf, None);
    }

    pixmap
}

fn write_png(pixmap: &Pixmap, path: &Path) {
    pixmap.save_png(path).unwrap_or_else(|e| panic!("writing {}: {e}", path.display()));
    println!("wrote {} ({}px)", path.display(), pixmap.width());
}

fn main() {
    let out = PathBuf::from(
        std::env::args().nth(1).unwrap_or_else(|| "src-tauri/icons".to_string()),
    );
    std::fs::create_dir_all(&out).expect("create output directory");

    // Sizes Windows actually asks for. 16/20/24/32 are the ones the tuning
    // exists for — Explorer, the taskbar, and Alt-Tab all land in that range.
    const ICO_SIZES: [u32; 8] = [16, 20, 24, 32, 48, 64, 128, 256];
    let mut ico = ico::IconDir::new(ico::ResourceType::Icon);
    for size in ICO_SIZES {
        let pm = render(size);
        let image = ico::IconImage::from_rgba_data(size, size, pm.data().to_vec());
        ico.add_entry(ico::IconDirEntry::encode(&image).expect("encode ico entry"));
    }
    let ico_path = out.join("icon.ico");
    let file = std::fs::File::create(&ico_path).expect("create icon.ico");
    ico.write(file).expect("write icon.ico");
    println!("wrote {} ({} sizes)", ico_path.display(), ICO_SIZES.len());

    // Standalone PNGs Tauri's bundler references.
    for (name, size) in [
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
        // Windows Store logos, if the app is ever listed.
        ("Square30x30Logo.png", 30),
        ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71),
        ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107),
        ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150),
        ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310),
        ("StoreLogo.png", 50),
    ] {
        write_png(&render(size), &out.join(name));
    }
}
