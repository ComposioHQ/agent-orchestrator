# PR1 verification and release stop

PR: https://github.com/Untrivial-ai/agent-orchestrator/pull/4906

## Current state

The local build-time stop in `frontend/scripts/mac-differential-rollout.json` is false.
Production macOS updates stay full-download-only. macOS sidecar
generation is unconditionally suppressed on every channel. Unsupported platforms,
including Windows and Linux, explicitly disable differential downloads.

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
before publishing sidecars. Manual sidecar removal is the emergency rollback;
there is no existing conductor kill-switch implementation.

## Conductor audit, part 1

Audit supplied by orchestrator 250 on 2026-09-05:

- `ao-releases` HEAD `aa936360`: `_pipeline.yml` creates macOS arm64/x64 ZIPs,
  generates channel feeds using public `feed.mjs`, verifies, uploads `dist/*`,
  then publishes. The current macOS safety barrier is absence of sidecars.
- `agent-orchestrator` main `0244fb8`: `feed.mjs` hashes macOS ZIPs with
  `hashFile`, emitting URL, SHA-512 and size, with no sidecar or `blockMapSize`.
  Windows and Linux use `writeBlockmap`.
- That baseline's `feed.test.mjs` explicitly asserts Nightly macOS has no sidecar.
- No conductor kill switch or compatible-client gate exists at the audited heads.

This PR retains explicit client default-disable and unconditional macOS sidecar
suppression. The Nightly feed regression checks both architectures, real full-ZIP
SHA-512/size metadata, no sidecars and no `blockMapSize`; Windows/Linux feed
generation remains unchanged. Do not infer a remote control from the local JSON
stop. A future conductor rollout must be independently reviewed after compatible
client deployment and verification, with legacy-client isolation established.
Audit part 2, supplied by orchestrator 250:

- `verify-feeds.mjs` forbids macOS blockmaps across latest, nightly and pr
  channels, requires Windows sidecars, and rejects macOS `blockMapSize`, macOS
  sidecar URLs and any stray unreferenced blockmap.
- `verify-remote-release` checks the exact draft asset inventory, downloads and
  compares the assets, then reruns feed verification.
- Audited Nightly `v0.12.11-nightly.202609041654` has Windows/Linux versioned
  blockmaps only. Its `nightly-mac.yml` lists two versioned ZIPs without
  `blockMapSize`.

The ordinary conductor cannot currently publish or reference macOS blockmaps
without deliberate verification policy and test changes. This is stronger than
feed-generation suppression alone. This PR must not relax that policy or produce
macOS sidecars. Its scope is explicit client default-disable, guarded capability
groundwork and real fallback safety. Any future conductor relaxation is a separate
reviewed change after compatible-client deployment and verification. Legacy
safety still depends on absent sidecars because the audited public baseline
has no explicit `disableDifferentialDownload` assignment.

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

The focused main/feed/preload suite passed 180 tests. The selected renderer
suite passed 88 tests. Project and E2E typechecks passed. The unsigned package
command exited 0 after building the Vite bundles, but its log stopped at
"Finalizing package" and no final app artifact was present. This does not count
as successful packaged-app acceptance.
The full synthetic harness finished with 13 passed and 1 failed: HTTP 416
violated descriptor integrity. Earlier runs also timed out. The regression is
retained as a failing test, with no skip or test-side fallback workaround. These are preparation
checks, not approval to enable the feature.

The brief's `npm run build` is not defined in this checkout. `npm run package`
is the available production bundle/package build. No release, tag, project or
native installation is created by this work.

## Rollout-isolation follow-up plan

1. Set the dependency disable flag before hydration on every platform; deny every unsupported state.
2. Remove macOS sidecar generation entirely from the release-feed path.
3. Require explicit remote authorization and compatible-client evidence before any future allow; keep unknown denied while the authoritative contract is unresolved.
4. Exercise real MacUpdater across cached ZIP/map cycles with sidecars present and policy disabled; record the contrasting legacy-client exposure without claiming old binaries can be patched remotely.
5. Re-run focused tests and keep the existing PR draft with the HTTP 416 blocker retained.

The isolation follow-up exercises two successive target versions against the
same cache directory. With the dependency disable flag set, existing ZIP/map
cache plus available sidecars still produces one full ZIP request per cycle and
no sidecar/range request. An implicit-allow legacy client also stays full-only
across cycles when sidecars are absent, even with a seeded cached ZIP/map. A
separate counterexample proves that publishing sidecars activates that legacy
client. It would be false to claim new code can retroactively disable old binaries.

Remote kill-switch source/schema and compatible-client criteria remain pending
an authoritative decision. The local gate stays false; no remote allow is inferred
from sidecar presence, local settings, a successful check, or a version string.

CI on `dd8d074c8` passed renderer smoke and both typechecks. Its full test suite
reported 3776 passed, 6 skipped and 2 failed: the retained HTTP 416 regression
and a telemetry fixture that supplied only an arm64 ZIP on an x64 runner. The
fixture now supplies both architectures so it tests transfer telemetry independently
of the host architecture.

Independent test-only candidate check: helper 273's upstream-source snapshot
passed all 14 real MacUpdater harness cases on Node 26.7.0, including HTTP 416
and sentinel descriptor integrity. Candidate DifferentialDownloader.js SHA-256:
`79d2eaea8f38473a40337e5682e1aa1da5e46305fe9f67556d58f52013353d23`.
The temporary test copy was removed; the installed dependency was unchanged.
Immediately rerunning stock 6.8.9 produced 13 passed and the HTTP 416 descriptor
failure. This is Node-transport evidence, not packaged Electron acceptance.
