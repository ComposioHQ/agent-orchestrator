# Design System — Agent Orchestrator

## Product Context
- **What this is:** A web-based dashboard for managing fleets of parallel AI coding agents. Each agent gets its own git worktree, branch, and PR. The dashboard is the operator's single pane of glass.
- **Who it's for:** Developers running 10-30+ AI coding agents in parallel. From solo devs to engineering teams.
- **Space/industry:** AI agent orchestration. Competitors: Conductor.build, T3 Code, OpenAI Codex app, Emdash. All are native Mac apps. Agent Orchestrator is the web-based alternative.
- **Project type:** Web app (Next.js 15, React 19, Tailwind v4). Kanban board with 6 attention-priority columns.

## Aesthetic Direction
- **Direction:** Industrial Precision
- **Decoration level:** Intentional — subtle depth through surface hierarchy, ambient glow on active states, gradient surfaces in dark mode. No decorative blobs, no gratuitous gradients.
- **Mood:** Trading terminal meets control room. Dense, scannable, utilitarian, with just enough warmth that developers want to live in it for 10 hours. "I'm running an operation" not "I'm organizing tasks."
- **Reference sites:** Conductor.build, t3.codes, openai.com/codex, emdash.dev

## Typography
- **Display/Hero:** Geist Sans, weight 680, letter-spacing -0.035em — same font as body but differentiated through weight and tracking. Tighter and heavier creates display hierarchy without a font swap. No cognitive gear-shifts on a scan-heavy dashboard.
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
- **Approach:** Restrained with signal accents. Color is a priority channel, not decoration.
- **Accent (cool):** #5B7EF8 — interactive elements, links, focus rings. Used sparingly.
- **Accent hover:** #7a96ff
- **Accent tint:** rgba(91, 126, 248, 0.12)
- **Attention (warm):** #f1be64 — states requiring human input. Amber is universally "needs attention" without the panic of red.

### Surfaces (Dark Mode)
| Token | Value | Usage |
|-------|-------|-------|
| bg-base | #0a0d12 | Page background |
| bg-surface | #11161d | Card/column backgrounds |
| bg-elevated | #171d26 | Modals, popovers, hover states |
| bg-elevated-hover | #1c2430 | Hover on elevated surfaces |
| bg-subtle | rgba(177, 206, 255, 0.05) | Subtle tints, pill backgrounds |

### Surfaces (Light Mode)
| Token | Value | Usage |
|-------|-------|-------|
| bg-base | #f5f5f7 | Page background |
| bg-surface | #ffffff | Card/column backgrounds |
| bg-elevated | #ffffff | Modals, popovers |
| bg-elevated-hover | #f7f7f8 | Hover states |
| bg-subtle | #f0f0f2 | Subtle tints |

### Text (Dark Mode)
| Token | Value | Usage |
|-------|-------|-------|
| text-primary | #eef3ff | Headings, card titles, body. Blue-white, not pure white. |
| text-secondary | #a5afc4 | Descriptions, metadata. Readable in dense layouts. |
| text-tertiary | #6f7c94 | Timestamps, placeholders, disabled states. |

### Text (Light Mode)
| Token | Value | Usage |
|-------|-------|-------|
| text-primary | #1b1b1f | Headings, card titles, body. |
| text-secondary | #5e5e66 | Descriptions, metadata. |
| text-tertiary | #8e8e96 | Timestamps, placeholders. |

### Borders (Dark Mode)
| Token | Value | Usage |
|-------|-------|-------|
| border-subtle | rgba(160, 190, 255, 0.08) | Dividers, section separators |
| border-default | rgba(160, 190, 255, 0.14) | Card edges, input borders |
| border-strong | rgba(185, 214, 255, 0.24) | Hover states, focus indicators |

### Status Colors
| Status | Dark Mode | Light Mode | Usage |
|--------|-----------|------------|-------|
| Working | #22c55e | #16a34a | Agent actively coding. Green dot with pulse ring animation. |
| Ready | #5B7EF8 | #5e6ad2 | Queued, awaiting start or CI pending. |
| Respond | #f1be64 | #ca8a04 | Needs human input. Amber = attention without panic. |
| Review | #06b6d4 | #0891b2 | Code ready for review. Cyan = "look when ready." |
| Error | #ef4444 | #dc2626 | CI failed, agent crashed. Red = broken. |
| Done | #3a4252 | #d0d7de | Completed. Fades to secondary text. Done items recede. |

- **Dark mode strategy:** Blue-tinted graphite palette (not neutral gray). Reduce font weight by one step in dark mode (semibold becomes 500, bold becomes 600). Inset highlights on elevated surfaces: `inset 0 1px 0 rgba(255,255,255,0.04)`. Subtle radial gradients on body for ambient depth.

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
  - base: 2px (cards, buttons, inputs — consistent, sharp, intentional)
  - sm: 4px (tooltips, small transient elements)
  - md: 6px (dropdowns, floating interactive elements)
  - lg: 8px (modals, large floating overlays)
  - full: 9999px (pills, badges, count indicators)
- **Card inset highlight:** `inset 0 1px 0 rgba(255,255,255,0.04)` in dark mode
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

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-28 | Initial design system created | Created by /design-consultation with competitive research (Conductor.build, T3 Code, OpenAI Codex, Emdash) + 4 design voices (primary, Codex CLI, Claude subagent, Emil Kowalski design eng) |
| 2026-03-28 | Geist Sans + JetBrains Mono (2 fonts only) | Emil review: 4 fonts creates cognitive gear-shifts on scan-heavy dashboards. Two fonts, hierarchy through weight + tracking. |
| 2026-03-28 | Accent #5B7EF8 instead of Tailwind blue-500 | Emil review: stock Tailwind blue reads "default" and undermines Industrial Precision identity. Existing token-reference blue is more sophisticated. |
| 2026-03-28 | Dual accent (cool blue + warm amber) | All 3 outside voices independently proposed amber for attention states. Two accents with clear semantic roles beat a single color. |
| 2026-03-28 | Fixed-width kanban columns (not variable) | Emil review: variable width breaks spatial memory. Encode urgency in column header dots instead. |
| 2026-03-28 | 2px base border-radius | Full 0px risks looking unstyled. 2px reads as intentionally sharp while feeling designed. Consistent across cards, buttons, inputs. Distinct from competitors' 8-12px rounded corners. |
| 2026-03-28 | Keep dot pulse, remove border heartbeat | Emil review: 4s border animation on 15+ cards is "decorative anxiety" with high perf cost. Existing 8px dot pulse is correct pattern — small surface, GPU-composited. |
| 2026-03-28 | Simplify ready-to-merge to single animation | Emil review: 3 concurrent keyframe animations on merge-ready cards is over-engineered. One animation per element, one purpose. Keep dot pulse only. |
