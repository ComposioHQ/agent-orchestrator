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

## Re-enabling updater feeds after a runtime safety containment

Withdrawing updater manifests is a fail-closed containment tool, not a release
rollback. If stable or nightly feeds have been disabled because an update or
downgrade could duplicate a session controller, keep every affected feed
disabled until all gates below pass. Existing tags, installers, and historical
release entries remain forensic evidence. **Never restore a withdrawn old
manifest:** it still selects the unsafe artifact. Re-enable a channel only by
publishing fresh manifests that select one newly verified release.

The sole release conductor owns the feed mutation. Code authors and test
operators may prepare artifacts and evidence but must not add, delete, or
replace manifests while the containment is active.

### 1. Candidate provenance and CI

- The candidate contains the reviewed runtime-provenance fix, including
  namespace-qualified handles, ownership-gated legacy adoption, ambiguous-owner
  rejection, and a pre-respawn live-controller fence.
- Required review is complete and every required CI job passes, including the
  full race-enabled backend suite and desktop tests.
- Candidate installers are produced once by the designated conductor from the
  reviewed commit. The packaged daemon's version/build metadata resolves to
  that exact commit on every platform; no locally rebuilt daemon is substituted.
- macOS zip and dmg artifacts pass
  `frontend/scripts/verify-mac-artifact.sh`. The ordinary Windows and Linux
  signing/package checks also pass before runtime testing begins.

### 2. Disposable update and downgrade matrix

Run this matrix only with copied fixture data and isolated `AO_DATA_DIR`,
`AO_RUN_FILE`, and `TMUX_TMPDIR` values. Do not point a candidate at a user's
live database, worktrees, tmux servers, agent homes, or native thread files.
Capture database rows, tmux server/socket identity, pane PID/start command, AO
supervisor PID/generation, and native-agent PID before and after every case.

- **Historical default -> candidate:** a uniquely AO-owned session on the
  system-default server is adopted without pane restart, input, resize, or
  process replacement. Its durable handle becomes qualified as `default`, its
  live launch generation is repaired, and a false `exited` activity becomes
  `idle` only when the exact supervised workload is alive.
- **Historical named -> candidate:** the same assertions pass for the legacy
  named `-L ao` server, with a qualified `named` handle.
- **Private -> candidate restart:** a private-socket session remains on the
  same socket with the same controller/process chain and a qualified `private`
  handle across two desktop restarts.
- **Clean candidate spawn:** a new session exists only on the run-file-derived
  private socket and survives attach, output, input, ordinary exit, and a safe
  resume without appearing in either legacy server.
- **Owned ambiguity:** the same AO session name and valid ownership stamp in
  any two, then all three, namespaces produces
  `RUNTIME_OWNERSHIP_AMBIGUOUS`. No candidate pane, process, durable generation,
  worktree, or native thread is changed.
- **Foreign collision:** a same-named user tmux session is never adopted or
  mutated. A foreign match cannot be converted into `exited` or used as a
  resume target.
- **Stale durable launch:** when the database generation differs from a live AO
  supervisor, resume returns `RUNTIME_CONTROLLER_ACTIVE` before
  `respawn-pane`, child launch, or generation writes. Repeat with the activity
  row already marked `exited`.
- **Candidate -> old build downgrade:** a namespace-qualified handle is
  rejected by each supported older packaged adapter. The old build may report
  recovery-required/inconclusive, but it must not create a tmux session,
  respawn a pane, start a second supervisor/native writer, or rewrite the
  qualified handle. Test both ordinary startup and an attempted Resume.
- **Active native writer:** using a disposable native-agent home and thread,
  keep one controller live and attempt a second restore. AO must reject before
  a duplicate controller is launched; the canonical writer and rollout remain
  unchanged, and the client receives a structured conflict rather than a
  successful Resume followed only by terminal stderr.
- **Windows control:** ConPTY create, attach, exit, and resume smoke tests pass;
  tmux-qualified handles and Unix compatibility scanning are never selected.

Every case must pass with zero unexplained PID, start-command, socket, handle,
or lifecycle changes. An inconclusive probe is a failed release gate unless the
expected outcome for that case is an explicit, non-mutating recovery-required
result.

### 3. Fresh-feed verification

- Build and exercise the candidate through the conductor's preview channel
  while the canonical stable and nightly feeds still have zero public
  candidates.
- Generate fresh stable/nightly manifests from the verified candidate
  artifacts only. Their version, checksum, size, and platform/architecture
  targets must match the assets tested above.
- Before making a feed public, inventory GitHub's release API, Atom output, and
  the shipped resolver's complete fallback window. There must be no older
  manifest that a client can select after skipping the new release.
- After publication, verify authenticated and unauthenticated API responses,
  Atom, `/releases/latest`, and direct macOS/Linux/Windows manifest URLs all
  select the exact verified tag and commit. Stable must not resolve to nightly;
  nightly must not fall back to a historical release.
- Canary one real update from the last supported stable and one from the last
  supported nightly on each desktop platform, then rerun the session/runtime
  invariants above. Stop and withdraw only the new manifests if any invariant
  fails; preserve the candidate release and artifacts for diagnosis.

Record the tested artifact digests, source commit, complete matrix results,
feed inventory, selected tag per platform/channel, conductor identity, and
timestamps in the incident issue before declaring either channel restored.

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

## Packaged runtime compatibility

macOS and Linux packages build and ship a pinned tmux under
`resources/tmux/bin/tmux`. Before spawning the daemon, Electron atomically
stages that binary in versioned storage under the AO data directory; this keeps
it available after a Linux AppImage mount disappears. The daemon derives an
explicit AO-private `tmux -S` socket from its run-file identity and starts tmux
without reading the user's tmux configuration. New sessions never leave that
socket.

For updates or downgrades involving older handles, the daemon scans the
historical named `-L ao`, system-default, and private sockets. It routes an
existing session only when its immutable pane command proves the same AO
run-file, session id, supervised marker, and launch generation, then persists a
namespace-qualified handle and repairs stale lifecycle facts. Multiple owned
matches require explicit recovery; a same-named user session is never adopted.
Older adapters reject qualified handles instead of treating them as bare tmux
names, which makes later downgrades fail closed.

Socket inodes remain in AO state. A bounded owner-only `/tmp` directory alias
handles deeply nested paths on macOS, and unsafe shared-writable socket
directories fail closed. Pane environments are applied over stdin before the
real command starts, keeping configured values out of process arguments.
Windows uses ConPTY and carries no tmux resource.

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

## Incident rule

Exactly one publisher is a correctness requirement. If the conductor is
unavailable or a release is partially staged, stop and recover through the
private runbook. Do not dispatch a public publishing workflow, create a
substitute release, mutate an existing release, or publish from a second
identity.
