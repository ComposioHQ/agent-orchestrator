# Reference Launch Video MVP

This repo now includes a pragmatic `ao launch-video` flow for a reference-driven launch-style video pipeline. The implementation persists reusable analysis, blueprint, judge, and render-plan outputs so later loops can iterate on the same reference without redoing extraction work when the file fingerprint has not changed.

## Artifact Tree

Artifacts are written under:

```text
/Users/suraj.markupgmail.com/Desktop/video-hackathon-mvp/
  reference/
    reference.json
    assets.md
  analysis/
    metadata.json
    scenes.json
    transcript.json
    audio-events.json
    style.json
    motion.json
    editorial.json
    blueprint-seed.json
    notes.md
    keyframes/*.jpg
  blueprints/
    blueprint-v1.json
  judge/
    judge-v1.json
    revision-v1.json
  renders/
    preview-v1.md
```

`preview-v1.md` is the current concrete build handoff. It maps scene timing, copy intent, assets, motion, palette, and editorial purpose for the next playable render.

## Blueprint Schema V1

`blueprint-v1.json` uses these top-level keys:

```json
{
  "project": {},
  "reference": {},
  "assets": {},
  "style": {},
  "audio": {},
  "performance": {},
  "editorial": {},
  "scenes": [],
  "judge": {}
}
```

The launch family roles are:

- `hook`
- `before`
- `after`
- `value-beats`
- `outro`

## Notes

- Analysis caches are keyed to reference path, size, and mtime.
- The Desktop folder is the primary user-facing output surface for this MVP.
- Scene detection is still heuristic, but the analysis bundle now includes real OCR text, palette extraction, and keyframe-difference motion signals from the actual reference frames.
- Transcript generation currently uses a real OCR-derived partial fallback when speech transcription is unavailable.
- On macOS, keyframe extraction and frame analysis use AVFoundation, Vision, and AppKit via a bundled Swift helper when `ffmpeg` is unavailable.
