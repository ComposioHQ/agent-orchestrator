# PR1 verification and release stop

PR: https://github.com/Untrivial-ai/agent-orchestrator/pull/4906

## Current state

The release gate in `frontend/scripts/mac-differential-rollout.json` is false.
Production macOS updates stay full-download-only. Nightly macOS sidecar
generation is also disabled. Windows and Linux behavior is unchanged.

Prepared changes preserve the approved eligibility matrix, fail-closed renderer
hydration, a serialized Developer Mode mirror, stale-form protection, per-operation
policy application, progress fields and sanitized telemetry through the renderer
capture allowlist. The gate must not open merely because these unit tests pass.

## Dependency stop: HTTP 416

The real MacUpdater harness uses electron-updater's production
`doDownloadUpdate`, `executeDownload`, `differentialDownloadInstaller`, cache
helper and HTTP digest pipeline. Only the Electron network transport and native
Squirrel handoff are substituted with local Node HTTP and a handoff recorder.
No test-side fallback downloader is used.

On HTTP 416, electron-updater 6.8.9's single-range response callback rejects but
continues piping the response and scheduling subsequent tasks. This races
closed file descriptors with the fallback. Local runs on Node 26.7.0 showed hangs, ECONNRESET, and an uncaught
descriptor-related Node error. The final harness also opens an unrelated sentinel
file at full-fallback entry: the HTTP 416 path closes that descriptor, failing
the descriptor-integrity assertion even when the ZIP download completes. Helper 273 also reproduced descriptor errors on
actual Node 24.20.0. A Homebrew node@24 PATH alias resolved to Node 26 locally;
runtime claims use `process.version`, not that alias.

A temporary, uncommitted dependency experiment added `response.resume(); return;`
immediately after rejecting an HTTP error. The targeted production-path test
then passed. The installed dependency was restored afterward. This is a root
cause check, not a shipped fix or evidence that every error path is safe.

Before enabling, require real production-path verification of no hang, exactly
one full fallback, no double completion, no descriptor error, and no native
handoff before successful SHA-512 verification. Include cancellation and
repeated failure attempts in that verification.

## Older-client feed isolation stop

Current main and older clients do not set `disableDifferentialDownload`; they
rely on missing macOS sidecars. Publishing ordinary Nightly `.zip.blockmap`
assets can therefore enable older clients regardless of Developer Mode,
especially after a successful full fallback caches a ZIP and its new blockmap.
A new client's gate does not protect those installations. Resolve feed isolation
before publishing sidecars. Removing sidecars remains the release kill switch.

## Evidence prerequisites

The approved brief was read from commit
`31e191cbd74e19fb0101395b8b0f3382ae0b0169`.
Helper 273 recovered the experiment from the shared reflog. The brief's SHA
contains a typo; the correct commit is
`74fabaa3f5ab2fb0178574391f7b9c735caedc4c`. Its REPORT.md, evidence.json and
requests.jsonl are retained unchanged under `experiments/macos-blockmap/evidence`.
The signed ZIP pair itself was not recovered or rerun.

The historical signed-artifact run reconstructed 111,107,214 bytes using
17,275,830 HTTP bytes, saving 84.45%. Expected and reconstructed SHA-512 were
`YlMFsT1OarEYY8VNKDdIkFDe2NMEVvnL5MERmFwXBgM/hPaRckInvnJmMP4iNA8TYltKd17fk4Ke9n7+uxVH7Q==`.
The recorded target and reconstructed copies passed codesign, Gatekeeper and
staple checks. This is recovered historical evidence, not a new signed-artifact run.

Helper 273 also confirmed the descriptor-ownership defect independently and
prepared an upstream source-patch proposal. Its dependency-boundary matrix is
support evidence only; it does not establish Electron net or native MacUpdater
handoff safety. No dependency patch is installed or included in product code.

The committed synthetic ZIP harness exercises both architecture selection paths.
It verifies byte identity and SHA-512, not code signing or native installation.
One local run observed:

| Fixture | Target bytes | HTTP response bytes | SHA-512 (base64) |
| --- | ---: | ---: | --- |
| arm64 | 512252 | 288799 | `v/hQNMqc3aypd503hhIu9uPpsy6jcsK1Fjli/cbUHtexTEqvCJ5DcN3sihsin+L4zlsUeBQujq5tfW1jnrq+2w==` |
| x64 | 512252 | 320374 | `4DfLYFJVpmSvLsJN6hL4bGMyrBUROlTFbrtMHoLKDKox25Bt21NC7JAzbwHOmUVFqjKkiYYEHgZLDCxO25BB9w==` |

## Verification commands

Run from `frontend`:

```sh
npx vitest run --config vite.main.config.ts scripts/blockmap.test.mjs scripts/feed.test.mjs src/main/update-settings.test.ts src/main/auto-updater.test.ts src/preload.test.ts src/shared/update-telemetry.test.ts
npx vitest run --config vite.main.config.ts scripts/blockmap-reconstruction.test.mjs
npx vitest run --config vite.renderer.config.ts src/renderer/lib/update-telemetry.test.ts src/renderer/lib/telemetry.test.ts src/renderer/components/GlobalSettingsForm.test.tsx
npm run typecheck
npm run package
```

The focused main/feed/preload suite passed 177 tests. The selected renderer
suite passed 88 tests. Typecheck and the unsigned package command exited 0.
The full synthetic harness finished with 10 passed and 1 failed: HTTP 416
violated descriptor integrity. Earlier runs also timed out. The regression is
retained as a failing test, with no skip or test-side fallback workaround. These are preparation
checks, not approval to enable the feature.

The brief's `npm run build` is not defined in this checkout. `npm run package`
is the available production bundle/package build. No release, tag, project or
native installation is created by this work.
