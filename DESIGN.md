# Kinquest DESIGN.md

The visual system for Kinquest. AI agents and people building UI here follow it. Modeled on the warm, photo-light consumer style of the Airbnb DESIGN.md (getdesign.md), adapted for a family game: near-white canvas, ink text, one warm accent, hairline borders, one shadow tier, big touch targets.

## Principles
- **Plain and warm.** Mostly white and ink. Coral is the single accent: the main action, a key fact, the active step. Never two accents fighting.
- **Show the real product.** Marketing pages show real game UI (clue cards, the cipher panel, the blueprint) rendered as HTML, not stock art or mood illustrations.
- **Kids read the Scout screen.** Big type (17px+), short lines, emoji as pictures, read-aloud button on every clue.
- **Grown-ups read the Keeper screen.** Calmer, denser: notebook, rule book, blueprint.
- **No violet or lavender** anywhere in the brand.

## Color tokens
| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#ffffff` | page background |
| `--surface` | `#f7f6f3` | soft panels, inputs on white |
| `--surface-2` | `#efede8` | pressed / strong surface |
| `--ink` | `#222222` | headings, primary text (never pure black) |
| `--body` | `#3f3f3f` | paragraph text |
| `--muted` | `#6a6a6a` | secondary text |
| `--hairline` | `#e6e3de` | borders, dividers |
| `--accent` | `#ff5a3c` | primary buttons, key facts |
| `--accent-press` | `#e2401f` | pressed primary |
| `--accent-soft` | `#fff0ec` | selected chips, soft highlight |
| `--scout` | `#0f8f7e` | Scout role (child) |
| `--scout-soft` | `#e3f4f1` | Scout surfaces |
| `--keeper` | `#2d63d8` | Keeper role (grown-up) |
| `--keeper-soft` | `#e8effc` | Keeper surfaces |
| `--key` | `#f5b400` | lit keys, rewards |
| `--wood` | `#6b4a2f` | door and key bar |
| `--good` | `#1f9d55` | correct, level up |
| `--bad` | `#c13515` | wrong, error text |

Game symbol colors (cipher, suspects): red `#e5484d`, blue `#3e7bfa`, green `#2fb36d`, yellow `#f2c418`.

## Typography
- Display: **Bricolage Grotesque** 600–700, letter-spacing −0.02em, `text-wrap: balance`.
- UI and body: **Inter** 400/500/600.
- Scale: hero 56/1.05 → 36 on phones · h2 36 · h3 22 · title 18/600 · body 16/1.55 · Scout body 18 · small 14 · micro 12/600 uppercase tracking 0.06em.
- Numbers in stats use `font-variant-numeric: tabular-nums`.

## Shape and depth
- Radius: 8px buttons and inputs · 14px cards · 20px large panels and phone frames · 9999px pills.
- One shadow tier: `0 0 0 1px rgba(0,0,0,.02), 0 2px 6px rgba(0,0,0,.04), 0 4px 8px rgba(0,0,0,.10)`. Used for floating cards, phone mocks, dropdowns. Everything else is flat with a hairline.

## Spacing
4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96. Section padding 96 desktop / 64 phone. Card padding 24. Page gutter 24 desktop / 16 phone, equal left and right.

## Components
- **Primary button:** accent fill, white text, 48px tall, 8px radius, 600 weight, Title Case verb + object (“Start an Expedition”).
- **Secondary button:** white, ink text, 1px ink border.
- **Chip:** 40px tall pill, hairline border; selected = accent border + accent-soft fill.
- **Input:** 52px tall, hairline border, 8px radius; focus = 2px ink border (no glow).
- **Card:** white, hairline border, 14px radius, 24px padding.
- **Role badge:** Scout teal / Keeper blue pill with emoji.
- **Key bar:** wood bar with one keyhole per player; a lit key turns gold.

## Motion
- Hero content enters once on load (fade + 12px rise, 500ms).
- Hover: linked cards lift 2px; buttons darken; press moves 1px down.
- Game feedback: keyhole glow, door swing on open, symbols light up in sequence.
- No scroll-triggered fades, no parallax, no carousels. Everything rests under `prefers-reduced-motion`.

## Accessibility
- Visible `:focus-visible` ring on every control (2px ink, 2px offset).
- Touch targets at least 44×44px; primary actions 48px.
- Toasts live in an `aria-live="polite"` region. Icon-only buttons have `aria-label`.
- Color is never the only signal: suspect colors are also written out.

## Locale
US English, Title Case for buttons and headings, curly quotes, “…” for loading states, `Intl` for dates and money ($7.99).
