# hyper brandkit

Extracted from https://hyper.io on 2026-07-18 (SvelteKit site, daisyUI theme, Google Fonts).
This is the source of truth for Build's visual identity.

## Logo

- `/logo.svg` — 61×61 rounded square (radius 12), **amber `#FABA00`** fill, white
  lightning-bolt glyph made of two opposing triangular strokes.
- Wordmark: lowercase **"hyper"**, set next to the mark.
- Motif to reuse: the bolt's two opposing triangles (create ↔ build).

## Color

Converted from the site's daisyUI HSL variables:

| Token | HSL (source) | Hex | Role |
| --- | --- | --- | --- |
| `primary` | 209 93% 52% | `#1286F6` | Azure — links, primary buttons, focus |
| `primary-focus` | 285 71% 57% | `#A340E0` | Purple — hover/active on primary |
| `secondary` | 122 62% 44% | `#2AB62F` | Green — success, "running" states |
| `accent` | 45 96% 50% | `#FAC105` | Amber — the logo color family (`#FABA00` in logo) |
| `neutral` | 212 31% 52% | `#5B7FA6` | Slate — muted chrome, secondary text |
| `base-100` | 180 6% 97% | `#F7F8F8` | Near-white app background |
| `base-200` | 180 1% 77% | `#C4C5C4` | Borders, dividers |
| `base-content` | 222 19% 18% | `#252C37` | Ink — dark navy-charcoal text |

Code blocks on the site use Prism default + Monokai-ish `#272822` panels.

**Derived neutrals (Build only).** The site's base-200 `#C4C5C4` is too dark
for hairlines at app density, so Build derives: `--hyper-line #E0E1E1`
(base-200 mixed toward white), `--hyper-soft #F1F3F4` (cool base tint),
`--hyper-charcoal #2F3947` (ink-family dark for neutral chrome). Amber is
standardized on the logo's `#FABA00` everywhere (the daisyUI accent var
computes `#FAC105`; one amber, the logo's, wins).

## Type

- **Space Grotesk** (300/400/500/600/700) — display AND body on hyper.io.
- **PT Mono** — code, terminal output, technical labels.
- Loaded via Google Fonts (`fonts.googleapis.com/css2?family=PT+Mono&family=Space+Grotesk:wght@300;400;500;600;700`).

## Voice & copy patterns

- Hero: **"Create. Connect. Build."** — three one-word imperatives with periods.
- Tagline: "a Service Framework for building hyperscale applications".
- Benefit framing: "build and focus on your application's features, not its
  cloud plumbing."
- ALL-CAPS eyebrow labels: `THE PROBLEM`, `OUR SOLUTION`, `MORE INFO >`.
- Numbered offering cards: `01 Data`, `02 Cache`, `03 Storage`, `04 Queue`,
  `05 Search`.
- Register: short declarative sentences, developer-direct, no hype-jargon;
  brand name always lowercase ("hyper").

## Tone summary

Light, spacious, technical-but-friendly. White space over decoration; code as
first-class content; one loud color (amber bolt) on a calm azure/ink system.
