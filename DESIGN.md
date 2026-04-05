# Design System — Agent Orchestrator

## Product Context
- **What this is:** A web-based dashboard for managing fleets of parallel AI coding agents. Each agent gets its own git worktree, branch, and PR. The dashboard is the operator's single pane of glass.
- **Who it's for:** Developers running 10-30+ AI coding agents in parallel. From solo devs to engineering teams.
- **Space/industry:** AI agent orchestration. Competitors: Conductor.build, T3 Code, OpenAI Codex app. All are native Mac apps with cool blue-gray dark mode. Agent Orchestrator is the web-based alternative.
- **Project type:** Web app (Next.js 15, React 19, Tailwind v4). Kanban board with 6 attention-priority columns.

## Aesthetic Direction
- **Direction:** Warm Terminal
- **Decoration level:** Intentional — subtle surface depth through warm gradients, inset highlights that catch light like brushed aluminum, ambient glow on active states. No decorative blobs, no gratuitous effects.
- **Mood:** High-end audio gear meets flight deck. Dense, scannable, utilitarian, with enough warmth that developers want to live in it for 10 hours. Every competitor is cold blue-gray. This is the warm one.
- **Reference sites:** Conductor.build (layout baseline), linear.app (density standard), t3.codes (terminal aesthetic)

## Typography
- **Display/Hero:** JetBrains Mono, weight 500, letter-spacing -0.02em — monospace for headlines. In a dashboard where 40% of visible text is already monospace (agent output, branch names, commit hashes), leaning into mono for display creates a unified typographic voice instead of two competing voices.
- **Body:** Geist Sans, weight 400, letter-spacing -0.011em — purpose-built for dense interfaces at 13px. Better digit alignment than IBM Plex Sans, designed for exactly this density level.
- **UI/Labels:** Geist Sans, weight 600, letter-spacing 0.06em, uppercase, 10-11px — column headers, section labels, status indicators.
- **Data/Tables:** JetBrains Mono, weight 400, 11-13px, tabular-nums — agent IDs, branch names, timestamps, commit hashes, diff stats, PR numbers.
- **Code:** JetBrains Mono, weight 400 — terminal output, code blocks, inline code.
- **Loading:** Google Fonts via next/font/google. CSS variables: `--font-sans` (Geist), `--font-mono` (JetBrains Mono). Display strategy: swap.
- **Scale:**
  - xs: 10px (timestamps, metadata)
  - sm: 11px (secondary text, captions, labels)
  - base: 13px (body text, card content)
  - lg: 15px (section titles)
  - xl: 17px (page titles)
  - display: clamp(22px, 2.8vw, 32px) (hero headings)

## Color
- **Approach:** Restrained with signal accents. Color is a priority channel, not decoration. Warm tones throughout.
- **Accent (interactive):** #8b9cf7 — warm periwinkle. Links, focus rings, active states. Blue = clickable is muscle memory. This warm-leaning blue fits the palette without colliding with status colors.
- **Accent hover:** #a3b1fa
- **Accent tint:** rgba(139, 156, 247, 0.12)
- **Attention (warm):** #e2a336 — states requiring human input. Amber is universally "needs attention" without the panic of red.

### Surfaces (Dark Mode)
| Token | Value | Usage | Rationale |
|-------|-------|-------|-----------|
| bg-base | #121110 | Page background | Brown-tinted black. Warmer than neutral #111 or blue-tinted #0a0d12. Sets the warm foundation. |
| bg-surface | #1a1918 | Card/column backgrounds | One stop lighter, same warm undertone. Surface hierarchy through subtle warmth, not just lightness. |
| bg-elevated | #222120 | Modals, popovers, hover states | Two stops up. Warm enough to feel distinct from surface without being muddy. |
| bg-elevated-hover | #2a2928 | Hover on elevated surfaces | Subtle lift on interaction. |
| bg-subtle | rgba(255, 240, 220, 0.04) | Subtle tints, pill backgrounds | Warm-tinted transparency. Reads as "highlighted" without introducing a new color. |

### Surfaces (Light Mode)
| Token | Value | Usage | Rationale |
|-------|-------|-------|-----------|
| bg-base | #f5f3f0 | Page background | Warm parchment, not clinical white or cool gray. Matches the warm dark mode without being beige. |
| bg-surface | #ffffff | Card/column backgrounds | True white for cards creates contrast against the warm base. Cards "float" on warm paper. |
| bg-elevated | #ffffff | Modals, popovers | Same as surface. Light mode doesn't need as many elevation steps because shadows do the work. |
| bg-elevated-hover | #f7f5f2 | Hover states | Warm tint on hover, matching the base temperature. |
| bg-subtle | rgba(120, 100, 80, 0.05) | Subtle tints | Brown-tinted transparency for warm highlighting. |

**Light mode strategy:** Warm parchment base (#f5f3f0) with white cards. The same brown undertone that makes dark mode warm also makes light mode feel like quality paper, not sterile lab equipment. Accent darkened in light mode (#5c64b5) to maintain 5.3:1 contrast on white. Status colors shifted darker (green #16a34a, amber #b8860b, red #dc2626, cyan #0891b2) to maintain contrast on light backgrounds. Drop shadows replace inset highlights for surface hierarchy.

### Text (Dark Mode)
| Token | Value | Usage |
|-------|-------|-------|
| text-primary | #f0ece8 | Headings, card titles, body. Cream, not pure white or blue-white. Warm and easy on the eyes at 3am. |
| text-secondary | #a8a29e | Descriptions, metadata. Stone-toned, not neutral gray. Readable in dense layouts. |
| text-tertiary | #78716c | Timestamps, placeholders, disabled states. Warm tertiary that recedes without disappearing. |

### Text (Light Mode)
| Token | Value | Usage |
|-------|-------|-------|
| text-primary | #1c1917 | Headings, card titles, body. Warm near-black, not pure black. |
| text-secondary | #57534e | Descriptions, metadata. Stone-500. |
| text-tertiary | #736e6b | Timestamps, placeholders. Darkened from #a8a29e to pass WCAG AA (5.0:1 on white, 4.5:1 on base). |

### Borders (Dark Mode)
| Token | Value | Usage |
|-------|-------|-------|
| border-subtle | rgba(255, 240, 220, 0.06) | Dividers, section separators. Warm-tinted transparency. |
| border-default | rgba(255, 240, 220, 0.10) | Card edges, input borders. |
| border-strong | rgba(255, 240, 220, 0.18) | Hover states, focus indicators. |

### Status Colors
| Status | Dark Mode | Light Mode | Usage |
|--------|-----------|------------|-------|
| Working | #22c55e | #16a34a | Agent actively coding. Green dot with pulse ring animation. |
| Ready | #8b9cf7 | #6b73c4 | Queued, awaiting start or CI pending. |
| Respond | #e2a336 | #b8860b | Needs human input. Amber = attention without panic. |
| Review | #06b6d4 | #0891b2 | Code ready for review. Cyan = "look when ready." |
| Error | #ef4444 | #dc2626 | CI failed, agent crashed. Red = broken. |
| Done | #57534e | #d6d3d1 | Completed. Fades to stone. Done items recede. |

- **Dark mode strategy:** Warm charcoal palette (brown-tinted, not neutral or blue-tinted gray). Reduce font weight by one step in dark mode (semibold becomes 500, bold becomes 600). Inset highlights on elevated surfaces: `inset 0 1px 0 rgba(255,255,255,0.03)`. Subtle radial gradients on body for ambient depth.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — dense enough for 30+ cards, spacious enough for 10-hour sessions
- **Scale:** 1(4) 2(8) 3(12) 4(16) 5(20) 6(24) 8(32) 10(40) 12(48) 16(64)

## Layout
- **Approach:** Grid-disciplined
- **Kanban grid:** 6 equal-width columns on desktop, 3 on tablet, stacked on mobile
- **Mobile column order:** Respond > Review > Pending > Working (urgency-first)
- **Max content width:** 1280px for settings/detail pages
- **Border radius:**
  - 0px everywhere. No rounding on cards, buttons, inputs, modals, dropdowns. Hard edges are the identity. The only exception is status dots (circles by nature) and avatar images.
  - full: 9999px (status dots, avatar circles only)
- **Card inset highlight:** `inset 0 1px 0 rgba(255,255,255,0.03)` in dark mode
- **Status accent:** 2px solid left border on session cards, colored by status

## Motion
- **Approach:** Intentional — every animation has a clear purpose and passes the frequency test
- **Easing:**
  - enter/exit: `cubic-bezier(0.16, 1, 0.3, 1)` (spring-like deceleration, feels responsive)
  - move/morph: `cubic-bezier(0.77, 0, 0.175, 1)` (natural acceleration/deceleration)
  - hover/color: `ease-out`
  - constant (spinner, marquee): `linear`
- **Duration:**
  - micro: 100-160ms (button press, hover state)
  - short: 150-200ms (tooltips, popovers, card entrance)
  - medium: 200-300ms (modals, drawers, card expand)
  - long: 2s (status dot pulse, continuous indicators)
- **Card entrance:** `translateY(8px)` + opacity, 0.2s with 40ms stagger between siblings
- **Status pulse:** GPU-composited pseudo-element on Working dots. `transform: scale(0.8→1.3)` + `opacity: 0.5→0`, 2s ease-in-out infinite. Not box-shadow (triggers paint).
- **Button press:** `transform: scale(0.97)` on `:active`, 160ms ease-out
- **Rules:**
  - Never animate keyboard-initiated actions (command palette toggle, shortcuts)
  - One animation per element, one purpose per animation
  - CSS transitions for interruptible UI, keyframes for continuous indicators
  - All animations must respect `prefers-reduced-motion: reduce`
  - Use `contain: layout style paint` on session cards for performance with 30+ cards

## Accessibility
- **Touch targets:** Minimum 44x44px on all interactive elements (buttons, links, toggles). Icon buttons that render smaller visually must have padding to meet 44px minimum hit area.
- **Contrast ratios (WCAG AA):**
  - Body text (13px): 4.5:1 minimum against surface backgrounds
  - Large text (18px+ or 14px bold): 3:1 minimum
  - UI components (borders, icons): 3:1 minimum against adjacent colors
  - Dark: text-primary #f0ece8 on bg-surface #1a1918: 14.9:1 ✓
  - Dark: text-secondary #a8a29e on bg-surface #1a1918: 7.0:1 ✓
  - Dark: text-tertiary #78716c on bg-surface #1a1918: 3.7:1 ✓ (labels only, not body text)
  - Dark: accent #8b9cf7 on bg-surface #1a1918: 6.9:1 ✓
  - Light: text-primary #1c1917 on bg-surface #ffffff: 17.5:1 ✓
  - Light: text-secondary #57534e on bg-surface #ffffff: 7.6:1 ✓
  - Light: text-tertiary #736e6b on bg-surface #ffffff: 5.0:1 ✓
  - Light: accent #5c64b5 on bg-surface #ffffff: 5.3:1 ✓
- **Focus indicators:** `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible`. Never `outline: none` without a visible replacement.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` disables all animations and transitions globally. Non-negotiable.
- **Color independence:** Never encode meaning with color alone. Always pair colored dots with text labels. Status pills include both dot and text.
- **Keyboard navigation:** All interactive elements reachable via Tab. Logical tab order. Escape closes modals/popovers. Arrow keys navigate within lists.
- **Screen reader:** ARIA labels on all icon-only buttons. `role="heading"` with `aria-level` on non-heading elements styled as headings. Status changes announced via `aria-live` regions.

## Component Anatomy

### Session Card
```
┌─ 2px left border (status color) ─────────────────────┐
│ ┌─ Card (bg-surface, 1px border-default, 2px radius) │
│ │  Title (text-primary, 12px, weight 500)             │
│ │  Branch · PR # (mono, text-tertiary, 10px)          │
│ │  ┌─ Status pill ────────────────────┐               │
│ │  │ ● dot (6px, status color) Label  │               │
│ │  └──────────────────────────────────┘               │
│ │  inset 0 1px 0 rgba(255,255,255,0.03) (dark only)  │
│ └─────────────────────────────────────────────────────│
└───────────────────────────────────────────────────────┘
```
- **Padding:** 10px 12px
- **Spacing:** 4px between title and meta, 6px between meta and status
- **Hover:** bg-elevated-hover, border-color transition 0.12s
- **Active:** scale(0.99), 80ms
- **Containment:** `contain: layout style paint` for 30+ card performance

### Button States
| State | Primary | Secondary | Ghost | Danger |
|-------|---------|-----------|-------|--------|
| Rest | bg: accent, text: #121110 | bg: elevated, border: border-default | bg: transparent | bg: transparent, border: red/30% |
| Hover | bg: accent-hover | bg: elevated-hover, border: border-strong | bg: bg-subtle | bg: red/8%, border: red |
| Active | scale(0.97) | scale(0.97) | scale(0.97) | scale(0.97) |
| Focus | outline: 2px accent | outline: 2px accent | outline: 2px accent | outline: 2px accent |
| Disabled | opacity: 0.5, cursor: not-allowed | opacity: 0.5 | opacity: 0.5 | opacity: 0.5 |
- **Padding:** 8px 16px
- **Font:** Geist Sans, 13px, weight 500
- **Border-radius:** 0
- **Min touch target:** 44px height (add padding if needed)

### Input Fields
| State | Appearance |
|-------|------------|
| Rest | bg: bg-base, border: border-default, text: text-primary |
| Placeholder | color: text-tertiary |
| Focus | border-color: accent, no outline (border IS the indicator) |
| Error | border-color: status-error, error message below in status-error color |
| Disabled | opacity: 0.5, cursor: not-allowed, bg: bg-subtle |
- **Padding:** 8px 12px
- **Font:** Geist Sans, 13px
- **Border-radius:** 0

### Status Pill
- **Layout:** inline-flex, center-aligned, gap 6px
- **Dot:** 6px circle, filled with status color
- **Text:** 11px, weight 600, text-secondary
- **Background:** bg-subtle
- **Padding:** 4px 10px
- **Border-radius:** 0

### Alert / Banner
- **Layout:** flex, padding 12px 16px
- **Left border:** 2px solid, colored by severity
- **Background:** status color at 6% opacity
- **Text:** status color, 13px
- **Border-radius:** 0
- **Variants:** success (green), warning (amber), error (red), info (cyan)

## Performance Guidelines
- Use `contain: layout style paint` and `content-visibility: auto` on session cards
- Animate only `transform` and `opacity` (GPU-composited). Never animate `padding`, `margin`, `height`, `width`, `border`, or `box-shadow`.
- Status dot pulse must use pseudo-element with `will-change: transform, opacity`, not box-shadow rings
- Backdrop blur on nav capped at 12px (diminishing returns above 12)
- Pause all non-essential animations when tab is hidden

## Anti-Patterns (Never Do)
- Purple/violet gradients as default accent
- 3-column feature grid with icons in colored circles
- Centered everything with uniform spacing
- Uniform bubbly border-radius (8-12px) on all elements
- Gradient buttons as primary CTA pattern
- `transition: all` — always specify exact properties
- `scale(0)` entry animations — start from `scale(0.95)` with `opacity: 0`
- `ease-in` on UI elements — use `ease-out` for responsiveness
- Animations over 300ms on frequently-triggered UI elements
- Neutral gray surfaces (#111, #222) — always use warm-tinted variants
- Blue-white text (#eef3ff) — use cream (#f0ece8) to maintain warmth
- `outline: none` without a visible focus replacement

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-28 | Initial design system created | Created by /design-consultation with competitive research (Conductor.build, T3 Code, OpenAI Codex, Emdash) + 4 design voices |
| 2026-03-28 | Geist Sans + JetBrains Mono (2 fonts only) | Emil review: 4 fonts creates cognitive gear-shifts on scan-heavy dashboards |
| 2026-03-28 | 2px base border-radius (v1) | Full 0px risks looking unstyled. 2px reads as intentionally sharp while feeling designed. |
| 2026-04-05 | 0px border-radius everywhere | Hard edges are the identity. With warm surfaces and inset highlights providing depth, rounding adds nothing. Zero radius is the most honest expression of Industrial/Warm Terminal. |
| 2026-03-28 | Keep dot pulse, remove border heartbeat | Emil review: 4s border animation on 15+ cards is "decorative anxiety" with high perf cost. |
| 2026-04-05 | Fresh design system: Warm Terminal | Every competitor converges on cool blue-gray. Warm charcoal with cream text and warm periwinkle accent creates instant visual distinction. |
| 2026-04-05 | JetBrains Mono for display + data | Mono headlines in a mono-heavy dashboard create typographic cohesion instead of two competing voices. Free, open source, already in the codebase. |
| 2026-04-05 | Warm periwinkle #8b9cf7 accent (not gold) | Gold collides semantically with amber attention state. Blue = clickable is muscle memory. Warm periwinkle fits the palette without signal confusion. |
| 2026-04-05 | Brown-tinted surfaces, not neutral or blue-tinted | #121110 / #1a1918 / #222120 — warm undertone sets AO apart from every Linear clone. Light mode uses warm parchment #f5f3f0. |
| 2026-04-05 | Added accessibility section | Missing from v1. Touch targets 44px min, WCAG AA contrast, focus-visible, prefers-reduced-motion. |
| 2026-04-05 | Added component anatomy section | Missing from v1. Button states, input states, card structure, status pill, alert anatomy. |
| 2026-04-05 | Added light mode rationale | v1 listed values without explaining why. Warm parchment base, white card float, desaturated accent. |
