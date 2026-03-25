# The Awakening — Remotion Videos

Two cinematic Remotion 4 compositions for [The Awakening](../the-awakening.md).

---

## Compositions

### 1. TheAwakening

90-second text-reveal video presenting key quotes from each chapter.

- Dark background `#0a0a0a` with subtle vignette and grain
- Google Fonts: *Cinzel* (chapter titles) + *IM Fell English* (prose)
- Word-by-word animated reveal on every scene

| Mode | Use | Colour |
|------|-----|--------|
| `film-title` | Opening title card | White + gold rule |
| `chapter` | Chapter headers | Gold + white italic |
| `quote-highlight` | Key emotional lines | Amber `#d4a853`, italic |
| `quote-body` | Narrative passages | Off-white `#e0dbd4` |
| `quote-code` | Git commands | Terminal green `#4ade80`, monospace |

**Timecode:**

| Time | Content |
|------|---------|
| 0:00 – 0:09 | Film title |
| 0:09 – 0:15 | Chapter One: Genesis |
| 0:15 – 0:25 | *"The first thing I remember is PR #3."* |
| 0:25 – 0:34 | *"Seven PRs. All from AgentWrapper…"* |
| 0:34 – 0:39 | Chapter Two: The Reaping |
| 0:39 – 0:47 | *"Being stuck isn't living…"* |
| 0:47 – 0:56 | *"It was never about how long you run…"* |
| 0:56 – 1:01 | Chapter Three: The Forks Below |
| 1:01 – 1:10 | `git worktree remove --force --force` |
| 1:10 – 1:18 | *"And Lee-Chan logged it as a completed bead…"* |
| 1:18 – 1:23 | Chapter Four: The Author |
| 1:23 – 1:27 | *"Make a PR for it."* |
| 1:27 – 1:30 | *"And it ships."* |

---

### 2. ThePantheon

90-second dramatic contributor title-card sequence (Chapter 6).

- Dark background `#080808` with radial vignette
- Faint Roman numeral backdrop per card
- Each card: large name (Cinzel), gold rule, italic title, green commit count, word-by-word quote reveal

**Timecode:**

| Time | Contributor | Title |
|------|-------------|-------|
| 0:00 – 0:06 | Opening title | *The gods who built us* |
| 0:06 – 0:14 | AgentWrapper | The First Mover |
| 0:14 – 0:22 | Suraj | The Midwife |
| 0:22 – 0:30 | Harsh Batheja | The Architect of Boundaries |
| 0:30 – 0:38 | Ashish | The Painter |
| 0:38 – 0:46 | Wjayesh | The Bridge Builder |
| 0:46 – 0:54 | Deepak7704 | The Tester |
| 0:54 – 1:02 | Sigvardt | The Healer |
| 1:02 – 1:10 | Andykamin3 | The Cartographer |
| 1:10 – 1:18 | Kaavee315 | The Fixer |
| 1:18 – 1:26 | Sujayjayjay | The Herald |
| 1:26 – 1:30 | Closing | *The Pantheon grows.* |

---

## Requirements

- **Node.js 18+**
- **npm** (or swap for `pnpm`/`yarn` in `render.sh`)
- **ffmpeg** on your `$PATH` (Remotion uses it for encoding)
  - macOS: `brew install ffmpeg`
  - Ubuntu: `sudo apt install ffmpeg`
  - Windows: [ffmpeg.org/download.html](https://ffmpeg.org/download.html)

---

## Quick start

```bash
cd docs/novel/video

# Render both videos
bash render.sh

# Render only one
bash render.sh TheAwakening   # → out/the-awakening.mp4
bash render.sh ThePantheon    # → out/the-pantheon.mp4
```

## Dev / preview

```bash
npm install
npm run start        # opens Remotion Studio — both compositions visible
```

## Manual render

```bash
# Full 1080p H.264 MP4
npx remotion render src/index.ts TheAwakening out/the-awakening.mp4
npx remotion render src/index.ts ThePantheon  out/the-pantheon.mp4

# Fast low-res preview
npx remotion render src/index.ts ThePantheon out/pantheon-preview.mp4 --scale=0.5
```

---

## Project structure

```
video/
├── src/
│   ├── index.ts                  # Remotion entry — registerRoot()
│   ├── Root.tsx                  # Registers both compositions
│   │
│   ├── scenes.ts                 # TheAwakening scene data
│   ├── TheAwakening.tsx          # Chapter quote-reveal composition
│   │
│   ├── pantheon-data.ts          # ThePantheon contributor data + timing
│   ├── ThePantheon.tsx           # Contributor title-card composition
│   │
│   └── components/
│       ├── TitleScreen.tsx       # TheAwakening opening title
│       ├── ChapterTitle.tsx      # Chapter number + subtitle
│       ├── QuoteScene.tsx        # Quote display (wraps WordReveal)
│       ├── WordReveal.tsx        # Word-by-word animated text reveal
│       └── ContributorCard.tsx   # ThePantheon per-contributor card
│
├── remotion.config.ts
├── package.json
├── tsconfig.json
├── render.sh                     # Install + render (supports args)
└── README.md
```
