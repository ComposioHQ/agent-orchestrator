# The Awakening — Remotion Video

Cinematic text-reveal video for [The Awakening](../the-awakening.md), rendered with [Remotion](https://www.remotion.dev/).

## What it looks like

- **90 seconds** at 30fps, 1920×1080
- Dark background (#0a0a0a) with subtle vignette
- Google Fonts: *Cinzel* for chapter titles, *IM Fell English* for prose
- Word-by-word animated text reveal on every scene
- Four visual modes:
  | Mode | Use | Colour |
  |------|-----|--------|
  | `film-title` | Opening title card | White + gold rule |
  | `chapter` | Chapter headers | Gold + white italic |
  | `quote-highlight` | Key emotional lines | Amber `#d4a853`, italic |
  | `quote-body` | Narrative passages | Off-white `#e0dbd4` |
  | `quote-code` | Git commands | Terminal green `#4ade80`, monospace |

## Scenes / timecode

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

## Requirements

- **Node.js 18+**
- **npm** (or swap for `pnpm`/`yarn` in `render.sh`)
- **ffmpeg** on your `$PATH` (Remotion uses it for encoding)
  - macOS: `brew install ffmpeg`
  - Ubuntu: `sudo apt install ffmpeg`
  - Windows: [ffmpeg.org/download.html](https://ffmpeg.org/download.html)

## Quick start

```bash
cd docs/novel/video
bash render.sh
# → out/the-awakening.mp4
```

## Dev / preview

```bash
cd docs/novel/video
npm install
npm run start        # opens Remotion Studio in the browser
```

## Manual render commands

```bash
# Full 1080p MP4
npm run render

# Preview low-quality while iterating
npx remotion render src/index.ts TheAwakening out/preview.mp4 --scale=0.5
```

## Project structure

```
video/
├── src/
│   ├── index.ts           # Remotion entry — calls registerRoot()
│   ├── Root.tsx           # Registers the TheAwakening composition
│   ├── TheAwakening.tsx   # Main composition — sequences all scenes
│   ├── scenes.ts          # Scene data: text, timing, variant
│   └── components/
│       ├── TitleScreen.tsx   # Opening film title
│       ├── ChapterTitle.tsx  # Chapter number + title
│       ├── QuoteScene.tsx    # Quote display (wraps WordReveal)
│       └── WordReveal.tsx    # Word-by-word animated text reveal
├── remotion.config.ts
├── package.json
├── tsconfig.json
├── render.sh              # One-shot install + render script
└── README.md
```
