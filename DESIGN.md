# Design System — Agent Orchestrator

## Product Context
- **What this is:** A dashboard for managing fleets of parallel AI coding agents working on your codebase
- **Who it's for:** Developers and engineering leads who supervise AI-assisted development at scale
- **Space/industry:** Developer tools — peers include Linear, Vercel, Railway, Retool
- **Project type:** Data-dense operator dashboard (web app)

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian with Linear-lineage polish
- **Decoration level:** Intentional — subtle gradient surfaces on dark cards, ambient radial glow on body background, glass-effect nav with backdrop blur. Light mode is minimal (no decoration).
- **Mood:** Serious operator console. Technical, calm, trustworthy. Prioritizes scan-ability and data density. The interface should feel like mission control for autonomous agents — you're supervising work, not doing it.
- **Reference sites:** linear.app, vercel.com/geist, railway.com

## Typography
- **Display/Hero:** IBM Plex Sans (700) — engineered, open-source, warm enough to avoid sterile terminal cosplay. Letter-spacing: -0.025em at display sizes.
- **Body:** IBM Plex Sans (400, 500) — readable at small sizes (13px base), supports the "operator console" thesis.
- **UI/Labels:** IBM Plex Mono (400, 500) — used for session IDs, branch names, diff stats, PR numbers, timestamps. Anything that reads as "data" rather than "prose."
- **Data/Tables:** IBM Plex Mono (400) with `font-variant-numeric: tabular-nums` — columns of numbers must align.
- **Code/Terminal:** JetBrains Mono (400, 500) — used exclusively in terminal/xterm views and code blocks. Distinguished from IBM Plex Mono by context: Plex Mono is UI chrome, JetBrains Mono is agent output.
- **Loading:** Google Fonts via `next/font/google` with `display: swap`. CSS variables: `--font-ibm-plex-sans`, `--font-ibm-plex-mono`, `--font-jetbrains-mono`.
- **Scale:**

  | Token | Size | Usage |
  |-------|------|-------|
  | xs | 10px | Column headers, uppercase labels, timestamps |
  | sm | 11px | Secondary text, captions, chip labels |
  | base | 13px | Body text, card descriptions, alerts |
  | lg | 15px | Section titles, detail headers |
  | xl | 17px | Page titles, hero headings |

- **Global letter-spacing:** -0.011em on body. Uppercase labels use +0.06em to +0.08em.

## Color

### Approach
Balanced — indigo (#5e6ad2) as the interactive accent, standard semantic status colors, blue-tinted graphite surfaces in dark mode. The system uses two complete palettes (light and dark) with CSS custom properties toggled via `.dark` class.

### Light Mode

| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg-base` | `#ffffff` | Page background |
| `--color-bg-surface` | `#ffffff` | Card surfaces |
| `--color-bg-elevated` | `#ffffff` | Elevated panels |
| `--color-bg-elevated-hover` | `#f7f7f8` | Hover state on elevated surfaces |
| `--color-bg-subtle` | `#f2f2f2` | Subtle backgrounds, chip fills |
| `--color-text-primary` | `#1b1b1f` | Headings, primary content |
| `--color-text-secondary` | `#5e5e66` | Descriptions, body text |
| `--color-text-tertiary` | `#8b8b93` | Captions, timestamps, muted labels |
| `--color-border-subtle` | `#e8e8ec` | Section dividers, card borders |
| `--color-border-default` | `#d9d9de` | Input borders, stronger dividers |
| `--color-border-strong` | `#c1c1c6` | Emphasis borders |
| `--color-accent` | `#5e6ad2` | Interactive elements, links, accent |
| `--color-accent-hover` | `#4850b8` | Hover state for accent |
| `--color-accent-subtle` | `rgba(94, 106, 210, 0.08)` | Accent tint backgrounds |

### Dark Mode

| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg-base` | `#0a0d12` | Page background (deep graphite) |
| `--color-bg-surface` | `#11161d` | Card surfaces |
| `--color-bg-elevated` | `#171d26` | Elevated panels |
| `--color-bg-elevated-hover` | `#1c2430` | Hover state |
| `--color-bg-subtle` | `rgba(177, 206, 255, 0.05)` | Subtle blue-tinted background |
| `--color-text-primary` | `#eef3ff` | Headings (blue-white) |
| `--color-text-secondary` | `#a5afc4` | Body text (blue-gray) |
| `--color-text-tertiary` | `#6f7c94` | Muted text |
| `--color-border-subtle` | `rgba(160, 190, 255, 0.08)` | Blue-tinted subtle borders |
| `--color-border-default` | `rgba(160, 190, 255, 0.14)` | Default borders |
| `--color-border-strong` | `rgba(185, 214, 255, 0.24)` | Strong borders |
| `--color-accent` | `#8fb4ff` | Interactive elements (lighter for dark bg) |
| `--color-accent-hover` | `#b4ccff` | Hover state |
| `--color-accent-subtle` | `rgba(143, 180, 255, 0.16)` | Accent tint backgrounds |

### Status Colors

| Status | Light | Dark | Meaning |
|--------|-------|------|---------|
| Working | `#5e6ad2` | `#6e8fff` | Agent is actively coding |
| Ready | `#1a7f37` | `#73e0aa` | PR approved, CI green, cleared to merge |
| Attention | `#9a6700` | `#f1be64` | Needs human decision |
| Error | `#cf222e` | `#ff7b72` | CI failed, agent stuck |
| Done | `#d0d7de` | `#202838` | Session completed |

### Semantic Accents

| Name | Light | Dark |
|------|-------|------|
| Blue | `#5e6ad2` | `#8fb4ff` |
| Green | `#1a7f37` | `#5fd39a` |
| Yellow | `#9a6700` | `#f1be64` |
| Orange | `#bc4c00` | `#ff9d57` |
| Red | `#cf222e` | `#ff7b72` |
| Violet | `#8250df` | `#b59cff` |

Each semantic color has a corresponding tint token (`--color-tint-{name}`) at 8% opacity (light) or 12% opacity (dark) for pill/badge backgrounds.

### Dark Mode Strategy
- Blue-biased graphite surfaces — not neutral gray, not warm. The blue tint makes the interface feel computational and live.
- `rgba()` borders with blue channel bias — borders glow faintly blue without being precious about it.
- Ambient radial glow on body — two radial gradients (blue at top-left 20% opacity, teal/violet at bottom-right 8% opacity) prevent the deep base from feeling like a void.
- Desaturated status colors — dark mode status values are lighter and slightly desaturated for readability against dark surfaces.
- Gradient card surfaces — subtle top-to-bottom gradient on cards creates depth layering.
- Inset highlight — `inset 0 1px 0 rgba(255,255,255,0.04)` on elevated surfaces implies a top light source.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — the dashboard is data-dense but not cramped. Cards have 10-12px internal padding, columns have 12px padding.
- **Scale:**

  | Token | Value |
  |-------|-------|
  | `--space-1` | 4px |
  | `--space-2` | 8px |
  | `--space-3` | 12px |
  | `--space-4` | 16px |
  | `--space-5` | 20px |
  | `--space-6` | 24px |
  | `--space-8` | 32px |
  | `--space-10` | 40px |
  | `--space-12` | 48px |
  | `--space-16` | 64px |

## Layout
- **Approach:** Grid-disciplined kanban
- **Primary layout:** Attention-priority kanban columns — Working > Pending > Review > Respond > Ready. Each column represents a level of human attention needed.
- **Grid:** 5 equal columns on desktop, 3 on tablet, stacked on mobile
- **Max content width:** No hard max — the dashboard is full-width to maximize data density
- **Card height:** ~242px for session cards (flexible based on content)
- **Border radius:**

  | Token | Value | Usage |
  |-------|-------|-------|
  | `--radius-sm` | 4px | Chips, small pills, inputs |
  | `--radius-md` | 6px | Theme toggle, dropdowns |
  | `--radius-lg` | 8px | Modals, larger containers |
  | `--radius-xl` | 12px | Feature cards |
  | `0` | 0px | Session cards, kanban columns, buttons — the utilitarian stance |

- **Note:** Cards and primary interactive surfaces use `border-radius: 0` as a deliberate design choice — sharp corners reinforce the industrial/utilitarian aesthetic.

## Motion
- **Approach:** Minimal-functional, with one standout exception
- **Easing:** ease (default), ease-out (entrances), ease-in-out (continuous)
- **Duration:**

  | Token | Value | Usage |
  |-------|-------|-------|
  | `--transition-quick` | 0.1s | Hover states, micro-interactions |
  | `--transition-regular` | 0.25s | Expand/collapse, page transitions |

- **Animations:**

  | Name | Description | Usage |
  |------|-------------|-------|
  | `slide-up` | 4px translateY + opacity fade | Card entrance in kanban columns |
  | `activity-pulse` | Box-shadow pulse (0 → 4px) | Activity dots on working sessions |
  | `spin` | 360deg rotate | Loading spinners |
  | `pulse` | Opacity 1 → 0.4 → 1 | Skeleton loading states |
  | `ready-rail-breathe` | Box-shadow intensity oscillation | Ready-to-Merge card body glow |
  | `ready-dot-pulse` | Scale 1 → 1.22 | Ready status indicator dot |
  | `ready-sheen` | Horizontal gradient sweep | Top-edge highlight on Ready cards |

- **Standout moment:** The Ready-to-Merge card is the system's most distinctive design element. It combines breathing box-shadow, a pulsing status dot, a green radial glow from below, and a horizontal sheen animation. This card earns visual prominence through motion, not just color — it's the single most recognizable UI moment in the product.

## Dark Mode Card Surfaces

Cards in dark mode use gradient backgrounds rather than flat colors to create depth:

| Token | Value |
|-------|-------|
| `--card-bg` | `linear-gradient(180deg, rgba(22,28,37,0.98) 0%, rgba(16,21,29,0.98) 100%)` |
| `--card-expanded-bg` | `linear-gradient(180deg, rgba(26,34,45,0.98) 0%, rgba(18,24,33,0.98) 100%)` |
| `--card-merge-bg` | `rgba(17,23,31,0.98)` |
| `--card-shadow` | `0 18px 36px rgba(2,6,12,0.24)` |
| `--card-shadow-hover` | `0 24px 54px rgba(2,6,12,0.34)` |
| `--card-inset` | `inset 0 1px 0 rgba(255,255,255,0.04)` |

Light mode cards use flat `#ffffff` with no shadows by default and minimal hover shadows.

## Z-Index Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--z-base` | 0 | Default layer |
| `--z-raised` | 10 | Cards, elevated content |
| `--z-nav` | 100 | Navigation bar |
| `--z-modal` | 200 | Modal dialogs |
| `--z-overlay` | 300 | Overlay backgrounds |
| `--z-toast` | 400 | Toast notifications |

## Future Considerations

Insights from competitive research and external design reviews (Codex + independent assessment, March 2026):

1. **Color system expansion:** The current palette has one light/dark value per accent. A full semantic ramp (subtle fill, strong fill, hover, pressed, focus, text-on-accent) would make the system more complete.
2. **Light mode investment:** Dark mode received significantly more design attention (gradients, ambient glow, inset highlights). Light mode is functional but flat — it could benefit from subtle surface differentiation and shadow depth.
3. **Mono font consolidation:** Two mono families (IBM Plex Mono for UI, JetBrains Mono for terminal) adds font weight. Consider whether one family could serve both roles.
4. **Brand differentiation:** The system is recognizably Linear-adjacent (same indigo accent, similar neutral ramp). A signature accent color could give the product its own visual identity.
5. **Border radius as semantic signal:** `border-radius: 0` everywhere creates visual monotony. Consider: sharp = structural containers, pill = status labels, rounded = interactive buttons.
6. **Motion vocabulary:** The Ready-to-Merge card proves the team can create distinctive motion. Extend that investment to Working-state cards (subtle shimmer, gradient shift) to make the active state feel more alive.
7. **"Done" treatment:** `#d0d7de` (light) reads more like "disabled" than "completed." Consider a desaturated steel or cool sage that signals accomplishment.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-27 | Initial design system formalized into DESIGN.md | Created by /design-consultation with competitive research (Linear, Vercel, Railway) and external design voices (Codex + Claude subagent). Documents existing system as-is. |
| 2026-03-27 | Keep IBM Plex Sans as primary font | Engineered, open-source, technical feel. Supports the "operator console" thesis better than Inter. Both reviewers validated the choice. |
| 2026-03-27 | Keep dual mono families (Plex Mono + JetBrains) | Semantic distinction: Plex Mono = UI chrome (session IDs, stats), JetBrains Mono = agent output (terminal, code). Flagged as potential consolidation target. |
| 2026-03-27 | Keep blue-tinted graphite dark mode | Both external reviewers called this the strongest part of the system. The blue bias makes the interface feel computational and live. |
| 2026-03-27 | Keep `border-radius: 0` on cards | Deliberate utilitarian stance. Both reviewers flagged this as both a strength (distinctive) and a risk (visual monotony). Keeping for now. |
