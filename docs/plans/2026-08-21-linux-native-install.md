# Native Linux Install for Agent Orchestrator — Implementation Plan

> **For agentic workers:** implement task-by-task; each task ends with a green test or a proven manual check, plus a commit. Steps use `- [ ]`.

**Goal:** On any Linux distribution, install AO as an ordinary application. A launcher entry you click, `agent-orchestrator` and `ao` on `PATH`, the system package manager owning the files and handling updates. Nobody should have to keep a downloaded `.AppImage` around and launch it by hand.

**Branch:** `feat/linux-packaging`, cut from `Aoagent/main` @ `52fde0279`. PR target `main` on `Untrivial-ai/agent-orchestrator`.

## Current state

Linux packaging is not greenfield. `frontend/forge.config.ts` already produces three Linux artifacts, and `.github/workflows/build-artifacts.yml` builds all of them for `linux-x64` on every release:

| Artifact  | Maker                                                | Published                    |
| --------- | ---------------------------------------------------- | ---------------------------- |
| AppImage  | `frontend/makers/maker-appimage.ts` (custom)         | release asset + `latest-linux.yml` feed |
| `.deb`    | `@electron-forge/maker-deb`                          | release asset                |
| `.rpm`    | `@electron-forge/maker-rpm`                          | release asset                |

So no distribution is unsupported in the sense of "AO does not run there". The gaps are about how a user installs, launches and updates.

| Distro family      | Install today                     | Launcher entry | `ao` on PATH | Updates                       |
| ------------------ | --------------------------------- | -------------- | ------------ | ----------------------------- |
| Debian / Ubuntu    | download `.deb`, `dpkg -i`        | yes            | **no**       | **none** (manual re-download) |
| Fedora / RHEL      | download `.rpm`, `dnf install`    | yes            | **no**       | **none** (manual re-download) |
| Arch               | **nothing**, falls back to AppImage | **no**       | **no**       | AppImage self-update          |
| Anything else      | AppImage                          | **no**         | **no**       | AppImage self-update          |

Three problems fall out of that table, and only one of them is Arch-specific.

**1. `ao` is on no Linux install path at all.** The CLI and the daemon are the same Go binary (`backend/cmd/ao`), bundled by `frontend/scripts/build-daemon.mjs` into the app payload at `resources/daemon/ao`. No Linux artifact exposes it. `which ao` fails on a machine with AO installed, so `ao preview <url>` (documented in `CLAUDE.md`) is unavailable to every Linux user regardless of how they installed.

**2. The AppImage has no desktop integration.** Running it means launching a file from wherever it was downloaded. The desktop entry `ao start` writes is deliberately not a fix: `backend/internal/cli/start.go` sets `NoDisplay=true` on it, because it exists only to register the `x-scheme-handler/ao-app` protocol, not to appear in a launcher. Users end up hand-writing entries with absolute paths into their download directory:

```ini
# a real, hand-written entry found in the wild
Exec=xdg-terminal-exec --app-id=TUI.tile -e ~/Downloads/Piyush/agent-orchestrator-linux-x64.AppImage
```

That is fragile (absolute path into `~/Downloads`) and wraps a GUI app in a terminal launcher.

**3. A package-manager install will try to self-update itself.** `initAutoUpdates()` in `frontend/src/main.ts:1963` starts electron-updater for every packaged build, with no check on how the app arrived. A `.deb` or `.rpm` install lives under root-owned `/usr/lib`, so an update attempt either fails noisily or leaves the package database out of sync with what is on disk. This is a live bug in the artifacts we already ship, not a hypothetical one.

**4. No `.deb` or `.rpm` update path.** Both are one-shot downloads. An AppImage user gets updates; a deb user does not.

**5. `x86_64` only.** `build-artifacts.yml:52` has a single `linux-x64` matrix leg. There is no aarch64 artifact in any format.

## Scope of this plan

Ordered by value per unit of work:

- **Phase A, cross-distro fixes.** Benefit every Linux user immediately and are prerequisites for everything else: expose `ao`, stop the updater from fighting the package manager, integrate the AppImage into the desktop.
- **Phase B, Arch packaging.** The one distro family with no native package at all.
- **Phase C, update paths for deb and rpm.** Hosted apt and dnf repos. Requires infrastructure and a signing key, so it is deliberately last and gated on a decision.

Explicitly **out of scope** (flag separately if they matter): Flatpak and Flathub submission, Snap, and the `linux-arm64` build matrix leg.

## Decisions

**Arch package repackages the released `.deb`; it does not build from source.** The `.deb` is already FHS-correct. `electron-installer-debian` (via `@electron-forge/maker-deb`) installs the app under `/usr/lib/<name>/`, symlinks `/usr/bin/<name>` at the executable, writes `/usr/share/applications/<name>.desktop`, and copies icons into `/usr/share/icons/hicolor/<res>/apps/`. That is the layout an Arch package wants, so `package()` is mostly a move. Building from source would mean a full Go daemon build plus an Electron/npm build plus `prepare-agent-browser.mjs` and `build-acp-runtime.mjs`, dragging hundreds of megabytes of `node_modules` and a bundled Chromium download into `makepkg`. Not worth it for a project that already publishes binaries.

Extracting the AppImage instead of the `.deb` is possible but strictly more work: the AppDir has its own layout that must be translated, whereas the `.deb` already matches.

**The updater gate is a single upstream predicate, not a per-package patch.** All three existing artifacts plus the future Arch package share the same bug, so the fix belongs in `frontend/src/main/auto-updater.ts` where one implementation and one test suite cover every install path.

**The AppImage keeps self-updating.** It is the fetch-and-run artifact the `ao start` bootstrapper depends on (`backend/internal/cli/start.go:228-254`) and the only Linux path with a working update feed. Nothing here changes that.

## File structure

| File                                            | Status | Responsibility                                                       |
| ----------------------------------------------- | ------ | -------------------------------------------------------------------- |
| `frontend/src/main/auto-updater.ts`             | modify | Predicate: is this install package-manager owned? (A2)               |
| `frontend/src/main/auto-updater.test.ts`        | modify | Cases per install path (A2)                                          |
| `frontend/src/main.ts`                          | modify | Call the gate from `initAutoUpdates` (A2)                            |
| `frontend/src/renderer/i18n/*.json` (8 locales) | modify | "Update with your package manager" string (A2)                       |
| `frontend/forge.config.ts`                      | modify | Ship `ao` at a stable path / add the deb+rpm `/usr/bin/ao` link (A1)  |
| `backend/internal/cli/start.go`                 | modify | Write a visible launcher entry for AppImage installs (A3)            |
| `packaging/arch/PKGBUILD`                       | create | The `agent-orchestrator-bin` package definition (B1)                 |
| `packaging/arch/agent-orchestrator-bin.install` | create | Icon + mime cache hooks (B4)                                         |
| `packaging/arch/.SRCINFO`                       | create | Generated by `makepkg --printsrcinfo`; required by AUR (B1)          |
| `packaging/arch/update-pkgbuild.sh`             | create | Bump `pkgver` + `sha256sums` from the latest release (B5)            |
| `packaging/arch/README.md`                      | create | Build, install, publish instructions (B5)                            |
| `packaging/repo/`                               | create | apt + dnf repo generation, if Phase C is approved                    |
| `README.md`                                     | modify | Install table: Arch row, and update instructions per format          |

## Global constraints

- No em dashes anywhere (prose, comments, copy). Use `.`, `,` or parentheses.
- All app state stays under `~/.ao` (`CLAUDE.md` hard rule). Packages write only into the system prefix; they must never seed or touch `~/.ao`.
- `openapi.yaml` and `frontend/src/api/schema.ts` are generated. This plan does not touch the API surface.
- The binary name is `agent-orchestrator` everywhere, matching `EXECUTABLE_NAME` in `frontend/forge.config.ts`. The desktop entry, the `/usr/bin` symlink and every package payload key off that name; drift means a broken launcher.
- Commit after each task.

---

## Phase A: cross-distro fixes

### A1. Expose the `ao` CLI on every Linux install

- [ ] Unpack a released `.deb` and `.rpm` and confirm the exact in-payload path of the Go binary (expected `usr/lib/agent-orchestrator/resources/daemon/ao`). Every later step depends on the real path, not this guess.
- [ ] Confirm the bundled binary is the full cobra CLI and not a daemon-only entrypoint: `ao --help` must list `preview`, `start` and the rest.
- [ ] Add a `/usr/bin/ao` symlink to the deb and rpm payloads. `electron-installer-debian` supports extra symlinks via maker options; if it cannot express this, add it in a Forge `postMake` hook or a small packaging script instead.
- [ ] Decide whether `/usr/bin/ao` is too generic a name to claim. Check the Debian, Fedora and Arch official repos for a collision. If one exists, ship `agent-orchestrator-cli` and symlink `ao` only where it is free.
- [ ] For AppImage users, document the equivalent (the binary is inside the AppImage, so either extract it or rely on `ao start`). An AppImage cannot install a PATH entry on its own.
- [ ] Check: on a deb and an rpm install, `ao --version` and `ao preview https://example.com` both work from a fresh shell.

### A2. Stop package-manager installs from self-updating

- [ ] Add a predicate to `frontend/src/main/auto-updater.ts`: the install is package-manager owned when `process.env.APPIMAGE` is unset **and** the app's own install directory is not writable by the current user.
- [ ] Call it from `initAutoUpdates()` in `frontend/src/main.ts:1963`, alongside the existing `!app.isPackaged` early return.
- [ ] Add vitest cases in `frontend/src/main/auto-updater.test.ts`: AppImage run updates; writable-directory run (macOS `/Applications`, Windows per-user NSIS) updates; root-owned-directory run does not.
- [ ] Surface it in the UI's update panel rather than failing silently: "Installed by your system package manager. Update with your package manager." Add the string to all 8 locales under `frontend/src/renderer/i18n/`.
- [ ] Check: new tests pass; a real deb install shows the message instead of attempting a download; an AppImage run is unchanged and still self-updates.

### A3. Give the AppImage a real launcher entry

- [ ] Extend the entry `ao start` already writes (`backend/internal/cli/start.go`, `agent-orchestrator-ao-app.desktop`) so it is a visible launcher entry, not only a protocol handler: drop `NoDisplay=true`, add `Icon`, `Categories=Development;`, and a `Comment`.
- [ ] Extract the icon from the AppImage (or ship it alongside the downloaded binary under `~/.ao`) and install it into `~/.local/share/icons/hicolor/`, so `Icon=` resolves by name rather than by absolute path.
- [ ] Keep the `Exec` quoting that `desktopExecPath` already does. `backend/internal/cli/start_test.go:283` covers a path with spaces and a `%`; that test must stay green.
- [ ] Run `update-desktop-database` after writing, as the existing code already does for `xdg-mime`.
- [ ] Check: after `ao start` on a machine with no AO installed, the app appears in the launcher with its icon and starts on click, with no terminal window.

---

## Phase B: Arch packaging

### B1. Skeleton PKGBUILD that installs the released deb

- [ ] Create `packaging/arch/PKGBUILD`: `pkgname=agent-orchestrator-bin`, `pkgver` pinned to the current release (`0.10.3`), `arch=('x86_64')`, `license=('MIT')`, `url` pointing at the GitHub repo.
- [ ] `provides=('agent-orchestrator')`, `conflicts=('agent-orchestrator')` so a future source package can coexist in the AUR namespace.
- [ ] `source=("$pkgname-$pkgver.deb::https://github.com/Untrivial-ai/agent-orchestrator/releases/download/v$pkgver/agent-orchestrator-linux-x64.deb")` with a real `sha256sums`.
- [ ] `depends`: derive the real list by running `ldd` over the unpacked ELF rather than guessing. Expect at least `gtk3`, `nss`, `alsa-lib`, `libxss`, `libnotify`, `xdg-utils`.
- [ ] `package()` unpacks the deb (`bsdtar -xf data.tar.*`) and moves `usr/lib`, `usr/bin`, `usr/share` into `$pkgdir/usr/`.
- [ ] Check: `makepkg -f` produces a package; `pacman -Qlp` lists `/usr/bin/agent-orchestrator`, `/usr/bin/ao`, `/usr/lib/agent-orchestrator/agent-orchestrator`, the desktop entry and the hicolor icons.

### B2. chrome-sandbox permissions

Electron's SUID sandbox helper must be `root:root` mode `4755` or the app aborts at startup with "The SUID sandbox helper binary was found, but is not configured correctly".

- [ ] In `package()`, `chmod 4755 "$pkgdir/usr/lib/agent-orchestrator/chrome-sandbox"`.
- [ ] Do **not** add `--no-sandbox` to the launcher as a workaround. Arch enables unprivileged user namespaces by default, so the sandbox works; disabling it silently weakens the renderer.
- [ ] Check: the installed app launches with no sandbox error on stderr, and `pacman -Qkk agent-orchestrator-bin` reports no permission mismatch.

### B3. Verify the bundled runtimes survive a root-owned prefix

- [ ] The app ships an agent-browser runtime (`frontend/scripts/prepare-agent-browser.mjs`) and an ACP runtime (`frontend/scripts/build-acp-runtime.mjs`) as `extraResource`. If either expects a writable directory next to itself, a `/usr/lib` install breaks it.
- [ ] Exercise both at runtime on an installed build, not just at launch: open the inspector rail's Browser tab, and start a session that uses an ACP agent.
- [ ] If either needs to write, relocate its scratch directory under `~/.ao` (which the `CLAUDE.md` hard rule already requires) rather than making the prefix writable.
- [ ] Check: both runtimes work from a pacman install with an unwritable `/usr/lib`.

### B4. Launcher entry, icon and the `ao-app://` scheme

- [ ] Verify the deb's own `/usr/share/applications/agent-orchestrator.desktop` is correct once relocated: `Exec` must be the `/usr/bin/agent-orchestrator` symlink, `Icon` the hicolor icon name, `Terminal=false`, and `MimeType` must include `x-scheme-handler/ao-app` (`forge.config.ts` passes `AUTH_PROTOCOL_MIME_TYPE` to the deb maker, so it should already be there).
- [ ] Create `packaging/arch/agent-orchestrator-bin.install` running `update-desktop-database` and `gtk-update-icon-cache` in `post_install`, `post_upgrade` and `post_remove`.
- [ ] Resolve the interaction with the user-level entry `ao start` writes (and which A3 makes visible). Two entries claiming `x-scheme-handler/ao-app` means `xdg-mime` resolution order decides the winner. Decide whether the packaged entry should win, and whether `ao start` should skip writing its entry when a system install is present. Record the answer; do not silently delete a file the package does not own.
- [ ] Check: the app appears in the launcher with its icon, launches on click with no terminal window, and `xdg-open ao-app://test` reaches it exactly once.

### B5. Version-bump script and verification runbook

- [ ] `packaging/arch/update-pkgbuild.sh`: read the latest release tag via `gh release view --json tagName`, rewrite `pkgver`, re-fetch the deb, recompute `sha256sums`, regenerate `.SRCINFO`.
- [ ] `packaging/arch/README.md` documenting the loop: `makepkg -si`, launch, `pacman -Rns agent-orchestrator-bin`, confirm nothing is left behind.
- [ ] Check: a clean install then removal leaves no orphan files (`pacman -Qo` on the former paths returns nothing) and does not touch `~/.ao`.

### B6. Publish to the AUR (gated on a decision)

- [ ] Confirm whether this package should be published to the AUR, and under whose account. An AUR package is a public maintenance commitment: it needs a `pkgver` bump on every upstream release or users get stale builds.
- [ ] If yes: create the AUR git remote, push `PKGBUILD` + `.SRCINFO`, and decide whether the release workflow opens a bump PR automatically or a human does it.
- [ ] If no: stop after B5. The in-repo `packaging/arch/` directory still gives anyone a one-command local install via `makepkg -si`.

---

## Phase C: update paths for deb and rpm (gated on a decision)

Only worth doing if AO wants Linux users on a supported update path rather than manual re-downloads. It needs a GPG signing key and somewhere to host, so it is a real infrastructure commitment, not a code change.

- [ ] Decide: host signed apt and dnf repos, or accept manual updates for deb/rpm and point those users at the AppImage when they want auto-updates. Record the decision either way.
- [ ] If hosting: generate the repo metadata in the release workflow, sign it, publish it (GitHub Pages is the cheapest option that does not add a new service).
- [ ] Document `apt` and `dnf` source setup in `README.md` alongside the direct download links.
- [ ] Check: `apt update && apt upgrade` and `dnf upgrade` both pull a new AO release on a test machine.

---

## Documentation (after Phase A and B)

- [ ] Add an Arch row to the install table in `README.md` (around line 177, alongside AppImage / Debian / Fedora).
- [ ] Say per format how updates work: AppImage self-updates, deb and rpm are manual (or repo-based after Phase C), Arch is `pacman -Syu` once the AUR package is bumped.
- [ ] Note that every Linux artifact is `x86_64` only, and why (see open questions).

## Risks

- **Payload layouts are assumed, not verified.** A1 and B1 must start by actually unpacking a released deb and rpm and listing them. Every path in this plan depends on what is really inside.
- **`ao` name collision.** Claiming `/usr/bin/ao` across three distro families is a namespace decision that is hard to reverse once users have it installed. Check before shipping, not after.
- **Two desktop entries.** A3 makes the AppImage entry visible while B4 ships a packaged one. On a machine that has done both, the user sees AO twice in their launcher and `xdg-mime` picks a winner arbitrarily. B4's decision step must cover this.
- **Release cadence.** A `-bin` package pinned to a release tag goes stale the moment upstream cuts a new version. B5's script is the mitigation; B6 decides who runs it.

## Open questions

1. **AUR: publish, or in-repo only?** Determines whether B6 happens and whether a public maintenance commitment is being made.
2. **Phase C at all?** Hosting signed apt/dnf repos is infrastructure. The alternative is telling deb/rpm users to use the AppImage if they want updates.
3. **`/usr/bin/ao` name claim.** See A1. Needs a check against the official repos of all three families.
4. **aarch64.** `build-artifacts.yml:52` has only a `linux-x64` matrix leg, so there is no arm64 artifact in any format to install or repackage. Adding a `linux-arm64` leg is separate work; flag it if aarch64 support matters.
5. **Flatpak.** Deliberately out of scope here. It would replace Phases B and C with a single universal package, at the cost of Flathub review and sandbox work for an app that spawns agent CLIs, git and terminals. Worth revisiting if per-distro packaging proves too costly to maintain.
