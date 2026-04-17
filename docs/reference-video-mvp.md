# Reference Video MVP

This repository now includes a small AO CLI workflow for the first hackathon slice of a reference-driven launch-style video system.

## Command

```bash
pnpm --filter @aoagents/ao-cli dev launch-video ingest /Users/suraj.markupgmail.com/Desktop/test.mp4
```

Build output can also be run from the compiled CLI:

```bash
pnpm --filter @aoagents/ao-cli build
node packages/cli/dist/index.js launch-video ingest /Users/suraj.markupgmail.com/Desktop/test.mp4
```

## What It Produces

Artifacts are persisted under:

```text
artifacts/reference-launch-videos/<video-name>-<source-hash>/
```

The stable artifact folder contains:

- `analysis/raw-analysis.json`
- `analysis/scenes.json`
- `analysis/summary.json`
- `frames/*.jpg`
- `keyframes/*.jpg`
- `audio/reference-audio.m4a` when the source contains audio
- `transcript/transcript.json`
- `blueprints/launch-style-blueprint.json`
- `builder/builder-scaffold.json`
- `notes/launch-style-notes.md`

If the source hash and sample interval match an existing manifest, the command reuses the stored analysis instead of regenerating frames and audio.

## Current MVP Scope

- macOS-native ingestion using Swift + AVFoundation
- sampled frame extraction without `ffmpeg`
- simple scene detection based on sampled frame deltas
- launch-style blueprint generation with editorial, audio, performance, and emotion placeholders
- builder scaffold JSON for the next rendering loop

## Known Gaps

- Transcript generation is intentionally stubbed. The pipeline extracts and stores audio, then writes a reusable transcript placeholder manifest for a later speech-to-text pass.
- Scene detection is heuristic and based on sampled visual changes, not shot-accurate video understanding.
- The builder scaffold does not render video yet; it only prepares stable inputs for the future build loop.
