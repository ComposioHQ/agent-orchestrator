# Desktop release architecture

Canonical desktop releases are conducted from the private
`Untrivial-ai/ao-releases` repository. That conductor is the only system allowed
to publish stable, nightly, or preview releases. The public
`Untrivial-ai/agent-orchestrator` repository supplies source and unsigned build
artifacts; it does not hold signing credentials or publish canonical releases.

Do not create release tags or try to publish from this repository. Operators
start and monitor releases in the private conductor, whose runbook contains the
authorized commands and recovery procedures.

## Release flow

At a high level, the conductor:

1. selects a public source commit and records its full SHA and release version;
2. dispatches `.github/workflows/build-artifacts.yml` in this repository with
   that pinned SHA and version;
3. downloads the resulting unsigned, short-lived workflow artifacts and
   `digests.json`, then verifies every artifact against the recorded digest;
4. performs signing, macOS notarization, packaging, and updater-feed generation
   in the private release repository;
5. uploads the complete release as a draft;
6. runs remote verification against the draft artifacts and feeds;
7. publishes the verified release atomically; and
8. updates Homebrew where the channel requires it.

Publication does not proceed when a digest, signature, notarization result,
feed, artifact set, or remote verification check differs from what the
conductor expects. A failed run is resumed or replaced from the conductor; it
is never bypassed by publishing directly from this repository.

## Public unsigned build boundary

`.github/workflows/build-artifacts.yml` remains intentionally dispatchable. It
accepts an explicit public ref/SHA and version, builds the four supported
desktop targets, and uploads unsigned workflow artifacts plus their SHA-256
digests. It has read-only repository permissions, does not use release signing
secrets, and does not create, edit, or publish GitHub Releases.

The private conductor pins the immutable source SHA before dispatch and treats
the returned digests as the handoff boundary. Signing credentials and release
publication permissions stay in `Untrivial-ai/ao-releases`.

Windows installers follow the same boundary (#4502): the NSIS maker
(`frontend/makers/maker-nsis.ts`) activates electron-builder code signing only
when signing credentials are present in the environment, so the public build
stays unsigned while the conductor signs with its own credentials downstream.

## Channels

- **Stable** releases are deliberate production cuts. After all verification
  gates pass, publication updates the stable updater feeds and the Homebrew
  distribution metadata.
- **Nightly** releases are conductor-scheduled builds from the configured public
  source line. They remain prereleases and update only nightly feeds.
- **Preview** releases are conductor-requested builds for an isolated candidate
  or change. They remain prereleases on their own preview channel and cannot
  replace stable or nightly feeds.

Version selection, channel naming, retention, and promotion policy belong to
the conductor. `frontend/package.json` may be stamped during an unsigned build,
but changing it in this repository is not a release trigger.

## Artifact verification

The conductor owns the authoritative verification and publication gates. For a
local diagnosis of a downloaded macOS artifact, use the repository's supported
verification script:

```bash
frontend/scripts/verify-mac-artifact.sh <artifact>
```

The script preserves the archive's code-signing metadata while extracting and
runs the expected signature, Gatekeeper, and notarization checks. Do not use a
plain `unzip` result to judge a macOS signature.

Stable macOS releases continue to include both a DMG for first installation and
a ZIP for electron-updater. The ZIP and `latest-mac.yml` must remain available:
electron-updater cannot install an update from a DMG. Nightly and preview
channels omit the first-install DMG.

## Guarded macOS Nightly differential updates

macOS ZIP blockmaps are an experimental Nightly-only release asset. The client
attempts a differential transfer only when all of these conditions hold:

- the host is macOS;
- the effective update channel is `nightly`;
- no `pr<N>` feature release is pinned; and
- Developer Mode is enabled.

The updater defaults to full ZIP downloads before renderer hydration, when the
settings file is missing or malformed, and for every other platform, channel,
or mode combination. Stable and preview feeds must not publish macOS blockmaps.
Windows and Linux updater behavior is unchanged.

The release kill switch is asset-side: remove every `.zip.blockmap` asset from
the affected Nightly release. MacUpdater then performs a clean full ZIP
download without a client update. Do not remove the ZIP or `nightly-mac.yml`.
After rollback, confirm the feed still resolves, the full ZIP SHA-512 matches
the manifest, and updater telemetry reports full transfer or a single fallback.

electron-updater 6.8.9 owns reconstruction, SHA-512 verification, and one clean
full-download fallback when the old blockmap is missing, the sidecar is
unavailable or corrupt, Range requests fail, reconstruction fails, or the
target digest does not match. AO does not implement a second downloader.
Structured updater logs and telemetry record eligibility, transfer mode,
fallback, byte counts, and target version without signed URLs or credentials.

This guarded rollout preserves the safety boundary documented in #3034,
#3151, #3267, and #3288. It does not enable stable or feature-channel
differential updates, change ZIP creation, signing, notarization, or claim that
native Squirrel installation is transactional. Staged A-to-B replacement
semantics remain separate work.

## Incident rule

Exactly one publisher is a correctness requirement. If the conductor is
unavailable or a release is partially staged, stop and recover through the
private runbook. Do not dispatch a public publishing workflow, create a
substitute release, mutate an existing release, or publish from a second
identity.
