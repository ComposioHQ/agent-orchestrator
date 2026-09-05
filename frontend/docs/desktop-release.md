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

The rollout is currently disabled in `scripts/mac-differential-rollout.json`.
The client consumes that gate. Feed generation unconditionally suppresses macOS
sidecars on every channel, independently of the client gate. Keep it disabled until
the HTTP 416 dependency regression and older-client feed isolation are resolved.
See `docs/superpowers/plans/2026-09-05-macos-blockmap-pr1-verification.md` at the
repository root for the stop evidence.

There is currently no conductor kill switch or compatible-client gate. The local
JSON flag is a disabled build-time stop, not remote authorization. A future
Nightly experiment requires an independently reviewed rollout in `ao-releases`
after compatible-client deployment and verification. Its required allow
conditions are:

- the host is macOS;
- the effective update channel is `nightly`;
- no `pr<N>` feature release is pinned;
- Developer Mode is enabled;
- the authoritative remote kill switch explicitly allows the attempt; and
- the client is verified compatible.

The updater explicitly disables differential downloads on every platform before renderer hydration,
when settings are missing or malformed, and for every other channel or mode
combination. Stable and preview feeds must not publish macOS blockmaps.
Unsupported platforms, including Windows and Linux, remain explicitly disabled.

Absent macOS sidecars are the current global safety barrier. The conductor's
`verify-feeds.mjs` forbids them on latest, nightly and pr channels, rejects macOS
`blockMapSize` and sidecar URLs, and rejects stray unreferenced blockmaps.
`verify-remote-release` verifies the exact draft inventory, downloads and compares
assets, and reruns feed verification. Ordinary publication cannot bypass these
checks without deliberate policy changes. Windows sidecars remain required.

The audited Nightly `v0.12.11-nightly.202609041654` contains Windows/Linux
versioned blockmaps only; its macOS manifest lists two versioned ZIPs without
`blockMapSize`. Older public clients lack an explicit disable flag, so their
safety still depends on that absence. Any conductor relaxation is separate
reviewed work after compatible-client deployment and verification.

The conductor must
independently suppress blockmaps until a gated client baseline is deployed and
verified. Deployment alone cannot prove all older clients upgraded: conventional
sidecars must remain absent wherever those clients can discover them. This repo
must not generate or publish macOS sidecars. A new client flag cannot protect an
old binary that still implicitly permits differential downloads.

The current emergency rollback is manual asset removal, not an existing
conductor control: remove every `.zip.blockmap` asset from
the affected Nightly release. MacUpdater then performs a clean full ZIP
download on its next attempt without a client update. A transfer that already
fetched its sidecars is not interrupted. Do not remove the ZIP or `nightly-mac.yml`.
After rollback, confirm the feed still resolves, the full ZIP SHA-512 matches
the manifest, and updater telemetry reports full transfer or a single fallback.

electron-updater 6.8.9 owns reconstruction, SHA-512 verification and the full
fallback. The real MacUpdater harness covers those boundaries, including
corrupt or absent sidecars and digest failures. HTTP 416 currently fails the
required clean-fallback contract, which blocks enabling this rollout. AO does
not implement a second downloader.

Structured logs and telemetry record eligibility, attempted differential
transfer, fallback and target version without dependency URLs or credentials.
`transferred_bytes` is the latest dependency progress sample for the active
transfer, not an aggregate HTTP byte count. It excludes blockmap traffic and
may exclude failed-attempt bytes. Missing progress metrics remain absent.
The local reconstruction harness separately counts actual HTTP response bytes.

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
