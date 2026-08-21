# Making AO Install Properly on Linux

**Branch:** `feat/linux-packaging`, cut from `Aoagent/main` @ `52fde0279`. PR target: `main` on `Untrivial-ai/agent-orchestrator`.

## The problem in one paragraph

On Linux today, most people run AO by downloading a file called an AppImage and double-clicking it wherever it landed, usually `~/Downloads`. It works, but AO never really gets *installed*: it does not show up in the applications menu, the `ao` command does not exist in the terminal, and nothing keeps it up to date except the app itself. This plan makes AO install like any other Linux app: it appears in your menu, `ao` works in a terminal, and your package manager owns it.

## What "done" looks like

Before:

```bash
$ which ao
ao not found
$ ~/Downloads/agent-orchestrator-linux-x64.AppImage   # the only way to launch it
```

After:

```bash
$ ao --version          # the CLI just works
$ ao preview localhost:5173
```

...and AO is in your applications menu with its icon, launched by clicking it.

## Background: the four ways to ship a Linux app

If these terms are new, this is all you need to know.

| Format       | What it is                                                                                          | Who uses it            |
| ------------ | --------------------------------------------------------------------------------------------------- | ---------------------- |
| **AppImage** | One big file that contains the whole app. Download, mark executable, run. No install step at all.   | Any distro             |
| **.deb**     | A real installable package. `apt`/`dpkg` unpacks it into system folders and tracks every file.      | Debian, Ubuntu, Mint   |
| **.rpm**     | Same idea, different package manager.                                                                | Fedora, RHEL, openSUSE |
| **AUR**      | Arch's community package repository. You publish a recipe file (a `PKGBUILD`); users' tools build and install from it. | Arch, Manjaro |

A **package manager** (`apt`, `dnf`, `pacman`) is the tool that installs software and tracks what it put where, so it can update or remove it cleanly. The AppImage bypasses all of that, which is exactly why it is both the easiest to ship and the worst to live with.

## What AO already has

This is not starting from zero. `frontend/forge.config.ts` already builds three Linux artifacts, and `.github/workflows/build-artifacts.yml` publishes all three on every release:

- **AppImage** (built by our own `frontend/makers/maker-appimage.ts`) plus an update feed, so it can update itself.
- **.deb** (`@electron-forge/maker-deb`).
- **.rpm** (`@electron-forge/maker-rpm`).

So AO *runs* everywhere. The problems are about installing, launching and updating.

## What is actually broken

Here is the same information as a table. Read down the "no" column.

| Your distro     | How you install today          | In your app menu? | `ao` in terminal? | Gets updates?         |
| --------------- | ------------------------------ | ----------------- | ----------------- | --------------------- |
| Ubuntu / Debian | download `.deb`, install it    | yes               | **no**            | **no**                |
| Fedora / RHEL   | download `.rpm`, install it    | yes               | **no**            | **no**                |
| Arch            | **no package exists**, use AppImage | **no**       | **no**            | yes (AppImage self-updates) |
| Anything else   | AppImage                       | **no**            | **no**            | yes                   |

Five problems fall out of that. Only one of them is about Arch.

### 1. `ao` is missing from every Linux install

The `ao` command and the background daemon are the *same* Go program (`backend/cmd/ao`). `frontend/scripts/build-daemon.mjs` bundles it inside the app, at roughly `resources/daemon/ao`. But no Linux package ever links it into `/usr/bin`, which is where your shell looks for commands.

Result: `which ao` fails on a machine with AO installed. `ao preview <url>`, which `CLAUDE.md` tells agents to use when showing frontend changes, is unavailable to every Linux user.

### 2. The AppImage never appears in your app menu

An AppImage is just a file. Nothing tells your desktop it exists.

AO does write a `.desktop` file (the small text file that puts an entry in your menu) during `ao start`, but look at `backend/internal/cli/start.go`: it sets `NoDisplay=true`, which means *deliberately hidden*. That entry exists only so clicking an `ao-app://` link opens AO. It was never meant to be a menu entry.

So people write their own by hand, like this real one:

```ini
Exec=xdg-terminal-exec --app-id=TUI.tile -e ~/Downloads/Piyush/agent-orchestrator-linux-x64.AppImage
```

Two things wrong with it: the path breaks the moment the file moves, and `xdg-terminal-exec` opens a terminal window to run a graphical app.

### 3. A properly installed AO fights its own package manager

When you install a `.deb` or `.rpm`, the app lands in `/usr/lib`, owned by root. You cannot write there without `sudo`, and that is the point: your package manager owns those files.

But `initAutoUpdates()` in `frontend/src/main.ts:1963` starts the auto-updater for *any* packaged build. It never checks how AO got onto the machine. So on a `.deb` install, AO tries to overwrite root-owned files it does not own. Best case it fails with an error. Worst case it half-succeeds and your package manager's records no longer match what is on disk.

This is a real bug in what we ship today, not a hypothetical one.

### 4. `.deb` and `.rpm` never update

You download the file once and that is the version you keep. There is no `apt` or `dnf` source to pull new releases from. Ironically the AppImage, the least "installed" option, is the only one that updates itself.

### 5. Everything is x86_64 only

`.github/workflows/build-artifacts.yml:52` builds one Linux target: `linux-x64`. On an ARM machine (Raspberry Pi, Ampere server, Asahi Linux on a Mac) there is no AO artifact in any format.

## The plan, in three phases

Ordered by value for effort.

### Phase A: fixes that help everyone (do these first)

Problems 1, 2 and 3 above are not distro-specific. They affect the packages we already ship. Fixing them helps every Linux user immediately and is a prerequisite for the rest.

### Phase B: an Arch package

Problem: Arch is the one major family with no native package at all. Fix: publish one.

### Phase C: updates for .deb and .rpm

Problem 4. Fixed by hosting signed `apt` and `dnf` repositories, both on GitHub itself: package payloads stay on Releases, and only the signed metadata needs publishing. Deliberately last, because it is the only phase that needs a key someone has to look after.

**Not in this plan** (say so if any of these matter): Flatpak, Snap, and ARM builds.

## Two decisions worth understanding up front

### The Arch package will repackage our `.deb`, not build from source

An Arch `PKGBUILD` is a recipe. It can either compile everything from source, or take an already-built file and re-lay it into Arch's folders. We do the second, because:

- Our `.deb` is *already* laid out correctly. `electron-installer-debian` puts the app in `/usr/lib/<name>/`, links `/usr/bin/<name>`, writes the `.desktop` file, and installs icons under `/usr/share/icons/hicolor/`. Arch wants the same layout, so the recipe is mostly a `mv`.
- Building from source would drag a full Go build, a full npm/Electron build, and a bundled Chromium download into every user's machine. Hundreds of megabytes for no benefit when we already publish binaries.

We repackage the `.deb` rather than the AppImage for the same reason: the `.deb` already matches the target layout, the AppImage does not.

### The updater fix goes in one place, not per-package

Problem 3 hits the `.deb`, the `.rpm`, and the future Arch package identically. So the check goes into `frontend/src/main/auto-updater.ts`, where one implementation and one set of tests covers all of them.

The AppImage keeps updating itself. It is the file the `ao start` bootstrapper downloads (`backend/internal/cli/start.go:228-254`) and the only Linux path with a working update feed. Nothing here changes that.

## Files this touches

| File                                            | New? | What for                                                       |
| ----------------------------------------------- | ---- | -------------------------------------------------------------- |
| `frontend/src/main/auto-updater.ts` + test      | edit | The "is this a package-manager install?" check (A2)            |
| `frontend/src/main.ts`                          | edit | Call that check before starting the updater (A2)               |
| `frontend/src/renderer/i18n/*.json` (8 files)   | edit | The "update with your package manager" message (A2)            |
| `frontend/forge.config.ts`                      | edit | Add the `/usr/bin/ao` link to the deb and rpm (A1)             |
| `backend/internal/cli/start.go`                 | edit | Make the AppImage's menu entry visible (A3)                    |
| `packaging/arch/PKGBUILD`                       | new  | The Arch recipe (B1)                                           |
| `packaging/arch/agent-orchestrator-bin.install` | new  | Refresh icon and menu caches after install (B4)                |
| `packaging/arch/.SRCINFO`                       | new  | Generated metadata the AUR requires (B1)                       |
| `packaging/arch/update-pkgbuild.sh`             | new  | Bump the recipe to a new release (B5)                          |
| `packaging/arch/README.md`                      | new  | How to build, install and publish it (B5)                      |
| `README.md`                                     | edit | Add an Arch row; explain updates per format                    |

## Rules to follow while implementing

- No em dashes anywhere, including comments and UI copy. Use `.`, `,` or parentheses.
- All app state stays under `~/.ao`. This is a hard rule in `CLAUDE.md`. Packages write only into system folders; never seed or touch `~/.ao`.
- The binary is called `agent-orchestrator` everywhere. It comes from `EXECUTABLE_NAME` in `frontend/forge.config.ts`, and the menu entry, the `/usr/bin` link and every package payload depend on that exact name. Change it in one place and the launcher breaks.
- `openapi.yaml` and `frontend/src/api/schema.ts` are generated files. This plan does not touch the API.
- Commit after each task.

---

## Phase A: fixes that help everyone

### A1. Put `ao` on PATH

*Why: so `ao --version` and `ao preview` work after installing AO.*

- [x] Unpack a real released `.deb` and `.rpm` and list what is inside. Both (v0.12.6) have the same layout, and the guessed path was right:
  - `/usr/lib/agent-orchestrator/resources/daemon/ao` (the Go binary, 30 MB)
  - `/usr/bin/agent-orchestrator` (symlink to `../lib/agent-orchestrator/agent-orchestrator`)
  - `/usr/share/applications/agent-orchestrator.desktop`
  - `/usr/share/pixmaps/agent-orchestrator.png` (a single pixmap, **not** `hicolor`, because the makers are passed one icon file rather than a size map)
- [x] Confirm the bundled binary is the full CLI, not just the daemon: `ao --help` lists `preview`, `start`, `session`, `spawn` and the rest. (`ao --version` prints `ao version dev` in the released deb, so the release build is not stamping a version. Separate bug, not this plan.)
- [x] Add a `/usr/bin/ao` link to the deb and rpm payloads. Neither maker can carry it in the payload: `electron-installer-debian` emits exactly one `/usr/bin` symlink (the launcher, from the `bin` option) with no option for a second, and `electron-installer-redhat` generates a spec whose `%files` list is fixed, so an extra file in the buildroot fails the build as unpackaged. Done with maintainer scripts instead (`frontend/packaging/linux/`), wired through `LINUX_CLI_SCRIPTS` in `forge.config.ts`: `postinst`/`postrm` for the deb, `%post`/`%postun` for the rpm. Each one refuses to touch a `/usr/bin/ao` that points somewhere else, and removal only fires on a real uninstall, not on the upgrade half of a reinstall.
- [x] Decide whether `ao` is too generic a name to claim. Nothing owns `/usr/bin/ao` in Debian trixie (contents search), Arch `core` or `extra` (their `.files` databases), or the rpmfind index of Fedora and friends. Claimed as `ao`; `agent-orchestrator-cli` not needed.
- [x] AppImage users cannot get a PATH entry from a single file. Documented in `README.md` under the download table: use `ao start`, or link the CLI out of an extracted AppImage.
- [x] **Verify:** done in containers, against the released v0.12.6 packages with the new scripts grafted on.
  - `debian:trixie`: `apt-get install ./ao-test.deb` creates the link; `ao --version` and `ao --help` work; a reinstall keeps the link; `apt-get remove` deletes it.
  - `fedora:latest`: the released rpm installed with `dnf`, then the two scriptlet bodies run exactly as rpm runs them (`$1` = 1, 2, then 0). Link appears, survives the upgrade-shaped `%postun`, disappears on erase, and a foreign `/usr/bin/ao` is left untouched.

### A2. Stop package-manager installs from self-updating

*Why: so a `.deb` install does not try to overwrite root-owned files (problem 3).*

- [x] Add a check to `frontend/src/main/auto-updater.ts`: `isPackageManagedInstall()` is true when `process.env.APPIMAGE` is unset **and** `dirname(process.execPath)` is not writable by the current user. Gated to Linux: an unwritable `Program Files` install updates fine through the elevated NSIS installer, and a read-only macOS bundle has its own preflight (`getMacInstallBlocker`).
- [x] Call it from `initAutoUpdates()` in `frontend/src/main.ts`, next to the existing `!app.isPackaged` early return. Also called by the three manual entry points (`checkForUpdatesNow`, `downloadUpdateNow`, `returnToHome`), which otherwise start a download that dies inside `/usr/lib`.
- [x] Add tests in `frontend/src/main/auto-updater.test.ts`: root-owned folder (does not update), AppImage with an equally read-only mount (updates), writable folder (updates), non-Linux regardless of permissions (updates), plus one that the three manual operations broadcast the reason and call nothing.
- [x] Show it in the app's update panel instead of failing quietly. The status carries a `packageManaged` flag rather than English prose, matching how `netError` is handled (#3526), and `UpdatesSection.tsx` renders `settings.updates.packageManaged`, added to all 8 files under `frontend/src/renderer/i18n/`.
- [x] **Verify:** the frontend suite and `tsc --noEmit` pass. On a real deb install in `debian:trixie`, a non-root user gets `/usr/lib/agent-orchestrator` unwritable and `APPIMAGE` unset (updater suppressed), while a home-directory folder is writable (updater runs).
  - Known and accepted: running the app as root makes the directory writable, so the check falls open and the updater runs. Root can overwrite those files anyway, so no check placed here would help.
  - Not covered: an end-to-end run of a freshly built deb, which needs a full Electron release build. The signals it depends on are the two verified above.

### A3. Give the AppImage a real menu entry

*Why: so AppImage users stop hand-writing `.desktop` files (problem 2).*

- [x] `ao start` already writes `agent-orchestrator-ao-app.desktop` (see `backend/internal/cli/start.go`). Now a real menu entry: `NoDisplay=true` is gone, and it carries `Icon`, `Categories=Development;`, a `Comment` and `StartupWMClass` (so the running window groups with the launcher). `registerLinuxProtocolHandler` is renamed `installLinuxDesktopEntry`, since registering the URL handler is no longer all it does.
- [x] Get an icon onto disk so `Icon=` can name it. Extracted from the AppImage: `installLinuxMenuIcon` runs `<appimage> --appimage-extract usr/share/icons/hicolor/1024x1024/apps/agent-orchestrator.png` in a scratch directory beside the AppImage under `~/.ao` (the AppImage unpacks into `./squashfs-root` relative to the working directory, hence `CommandOutputInDir`), then installs the PNG into `<XDG_DATA_HOME>/icons/hicolor/1024x1024/apps/`. Only the one file is unpacked, in milliseconds, and the scratch directory is removed. Failure is reported on stderr and never blocks the launch.
- [x] Keep the existing `Exec` quoting done by `desktopExecPath`. The space-and-`%` case is still covered, now asserted against `strings.ReplaceAll(appPath, "%", "%%")` rather than a hand-spelled string.
- [x] Run `update-desktop-database` after writing the file. Best effort, like the icon: not every machine ships `desktop-file-utils`, and desktops that watch the directory do not need it.
- [x] **Verify:** unit tests cover the entry contents, the icon landing in the theme, the scratch directory being cleaned up, the exact command sequence, and both best-effort steps failing without blocking the launch. Against the real released v0.12.6 AppImage the entry is written, the 51274-byte icon lands in the theme, `update-desktop-database` and `xdg-mime` both succeed, and `desktop-file-validate` accepts the generated file with no warnings.
  - Left for a human on a desktop session: clicking the menu entry. Everything up to the menu cache is verified above.
  - Open, and B4's to settle: a machine with both the AppImage and a system package now has two entries (this one and the package's `/usr/share/applications/agent-orchestrator.desktop`), and `xdg-mime default` here points `ao-app://` at this one.

---

## Phase B: the Arch package

### B1. Write the PKGBUILD

*Why: so Arch users can `makepkg -si` instead of juggling an AppImage.*

- [x] Create `packaging/arch/PKGBUILD`: `pkgname=agent-orchestrator-bin`, `pkgver=0.12.6` (the current stable release), `arch=('x86_64')`, `url` pointing at the GitHub repo. `license=('Apache-2.0')`, **not** MIT: the repo's `LICENSE` is Apache-2.0. The license file is a second `source=` pulled from the release tag, installed next to the bundled Electron's MIT text.
  - Finding, out of scope here: `frontend/forge.config.ts` tells the rpm maker `license: "MIT"`, so every published rpm claims the wrong license. Worth a separate fix.
- [x] Add `provides=('agent-orchestrator')` and `conflicts=('agent-orchestrator')`.
- [x] Point `source=` at the released deb, with a real `sha256sums` value. `noextract=` is set for it: makepkg does not unpack a `.deb`, so `package()` does it explicitly.
- [x] Work out `depends=` from `readelf -d` on the shipped binary (direct `NEEDED` entries), each mapped to its owning Arch package. 22 entries plus two that never appear in `NEEDED` because they are dlopen'd or spawned: `libnotify` and `xdg-utils`. `libxss` is in every Electron packaging guide and is deliberately absent: this build does not link it.
- [x] In `package()`, pipe the deb's `data.tar*` payload straight into a second `bsdtar` (compression-agnostic) and lay it into `$pkgdir`. Then: drop `usr/share/doc` and `usr/share/lintian`, reinstall the pixmap as a themed `hicolor` icon, add `/usr/bin/ao` as a tracked symlink, and install both licenses.
- [x] **Verify:** `makepkg -f` builds `agent-orchestrator-bin-0.12.6-1-x86_64.pkg.tar.zst`, and `pacman -Qlp` lists `/usr/bin/agent-orchestrator`, `/usr/bin/ao`, the app under `/usr/lib/agent-orchestrator/`, the `.desktop` file, the hicolor icon and both license files (6521 paths total).

### B2. Fix the sandbox permissions

*Why: without this, Electron refuses to start.*

Electron ships a helper called `chrome-sandbox` that isolates web content from the rest of your machine. Linux requires that helper to be owned by root with a special permission bit (`4755`, "setuid"), or Electron aborts with:

```
The SUID sandbox helper binary was found, but is not configured correctly.
```

- [x] In `package()`, run `chmod 4755 "$pkgdir/usr/lib/agent-orchestrator/chrome-sandbox"`.
- [x] Did **not** add `--no-sandbox`. Arch has the kernel feature the sandbox needs enabled by default.
- [x] **Verify:** on a real `pacman -U` install, `ls -l` shows `-rwsr-xr-x root root`, the app starts from `/usr/lib` with no sandbox error (daemon up, HTTP 200s), and `pacman -Qkk agent-orchestrator-bin` reports `6522 total files, 0 altered files`.

### B3. Check the bundled runtimes survive a read-only install

*Why: `/usr/lib` is root-owned, and AO bundles helper programs that might expect to write next to themselves.*

- [x] Both scripts run at BUILD time, not runtime: nothing is downloaded or installed on the user's machine on first launch. What ships is a prebuilt `agent-browser` binary and a bundled Node plus `node_modules` for ACP.
- [x] Neither writes beside itself. `AgentBrowserRuntime` puts its runtime root, owner file and sockets under `options.dataDir` (`~/.ao`), with a short `/tmp` symlink only because agent-browser enforces the macOS 103-byte socket path limit on every Unix build. The ACP driver only reads: it runs the packaged `node` against the packaged entrypoint.
- [x] Exercised on a real pacman install, against an isolated `AO_DATA_DIR` so the developer's own `~/.ao` was untouched:
  - ACP: `ao spawn --harness claude-code --mode chat` produced a live session running `/usr/lib/agent-orchestrator/resources/acp-runtime/node/bin/node` against the packaged `claude-agent-acp`.
  - Packaged runtimes execute fine from a root-owned directory: `node --version` reports v22.23.2, `agent-browser --version` reports 0.33.1.
  - Browser: opening the inspector rail's Browser tab on that session rendered the `ao preview` URL, so `agent-browser` ran from `/usr/lib` and drove a live page. Screenshot confirmed by the developer at the desktop.
- [x] **Verify:** both runtimes work from a pacman install, and `pacman -Qkk agent-orchestrator-bin` reported `0 altered files` throughout, so nothing wrote into `/usr/lib`.

### B4. Menu entry, icon, and the `ao-app://` link handler

*Why: two different `.desktop` files could end up claiming the same links.*

- [x] The deb's entry survives the move unchanged and is correct: `Exec=agent-orchestrator %U` (resolved on PATH, which the package provides), `Icon=agent-orchestrator` (a name), `MimeType=x-scheme-handler/ao-app;`. It has no `Terminal` key at all, and the freedesktop default for that key is `false`, so no terminal window. Its `Categories=GNOME;GTK;Utility;` comes from the deb maker; left alone so the Arch entry does not diverge from the deb.
- [x] Create `packaging/arch/agent-orchestrator-bin.install` running `update-desktop-database` and `gtk-update-icon-cache` on install, upgrade and removal.
- [x] **Decision on the clash: the packaged entry wins.** When `ao start` is launching the packaged app (`/usr/bin/agent-orchestrator`, or anything under `/usr/lib/agent-orchestrator/`) **and** `/usr/share/applications/agent-orchestrator.desktop` exists, it writes no entry of its own and points `xdg-mime` at the package's. The packaged file is never touched. The entry a previous `ao start` wrote **is** removed, because it is ours and by then points at an AppImage this machine no longer runs.
  - Fixed alongside it: `knownAppLocations` on Linux had no `/usr/bin` entry, so `ao start` on a machine with the deb, rpm or Arch package installed downloaded an AppImage it did not need. It is scanned last, since the AppImage is the copy that self-updates.
- [x] **Verify:** against a real pacman install, `ao start` resolved `/usr/lib/agent-orchestrator/agent-orchestrator`, removed a planted stale entry, wrote none of its own, and left `x-scheme-handler/ao-app=agent-orchestrator.desktop` in `mimeapps.list`. Unit tests cover both branches. Clicking the menu entry is the human step at the desktop.

### B5. A script to bump versions, and a test runbook

*Why: a package pinned to `0.10.3` is stale the day `0.10.4` ships.*

- [x] Write `packaging/arch/update-pkgbuild.sh`: reads the latest stable tag with `gh release list --exclude-pre-releases` (nightlies are tagged in the same repo and must never be pinned), or takes a version argument. Rewrites `pkgver`, resets `pkgrel`, re-downloads the deb and the tagged LICENSE, rewrites the whole `sha256sums` block (order matters, so it is replaced wholesale rather than line-edited), and regenerates `.SRCINFO`.
- [x] Write `packaging/arch/README.md` covering the full loop: install, what lands where, how to check it worked, updating, removal, and why nothing is on the AUR yet.
- [x] **Verify:** bumping to 0.12.5 in a scratch copy rewrote `pkgver`, the deb checksum and `.SRCINFO`, and correctly left the LICENSE checksum alone (the file is identical across those tags).
- [x] **Verify:** `pacman -Rns agent-orchestrator-bin` left nothing behind. `/usr/lib/agent-orchestrator`, both `/usr/bin` links, the desktop entry, the hicolor icon and the license directory are all gone, `pacman -Qo /usr/bin/ao` finds no owner, and `~/.ao` is intact (the package never wrote there; the test ran against an isolated `AO_DATA_DIR`).

### B6. Publish to the AUR (needs a decision first)

- [x] **Decision (2026-08-21): not yet.** Test the package locally first. `packaging/arch/` in the repo already gives anyone a one-command install with `makepkg -si`; publishing is a public promise to bump on every release and can be made later.
- [ ] Revisit once the local install has been lived with for a while: AUR account, git remote, and whether the release workflow opens the bump automatically or a person runs `update-pkgbuild.sh`.

---

## Phase C: updates for .deb and .rpm

- [x] **Decision (2026-08-21): host signed repositories**, using only GitHub. No new service, no server to run.
- [x] Two constraints decided the shape, and neither was in the original sketch:
  - **GitHub Pages cannot host the packages.** It rejects any file over 100 MB and the `.deb` is around 140 MB. So the packages stay on GitHub Releases and only the (few KB of) signed metadata needs a home.
  - **The Pages site is already the landing page.** `deploy-landing.yml` publishes it, and a second Pages deploy replaces the first, so the metadata could not simply be added there without entangling the two.
- [x] Where each package manager's metadata ended up, and why it had to be different:
  - **apt** resolves a package's `Filename` relative to the repository base, so metadata and package must share a base. The metadata is uploaded to the same release as assets, and users point at `releases/latest/download/`, which always resolves to the newest stable release. "Upgrade" is whatever that alias points at today.
  - **dnf** needs a `repodata/` subdirectory, which flat release-asset names cannot express. Its metadata is pushed to a `linux-repo` branch and served from `raw.githubusercontent.com`; `primary.xml` carries an `xml:base` pointing back at the release, so the `.rpm` still comes from GitHub Releases.
- [x] Neither published package is re-signed. The chain is `InRelease -> Release -> Packages -> .deb` and `repomd.xml.asc -> repomd.xml -> primary.xml -> .rpm`, each link a recorded SHA-256. Re-signing would mean overwriting an already published asset, and other things (the Arch `PKGBUILD`, the update feed) pin those bytes. The dnf `.repo` therefore sets `gpgcheck=0` with `repo_gpgcheck=1`: claiming a package signature that does not exist would fail every install.
- [x] `packaging/linux-repos/build-apt-repo.sh` and `build-dnf-repo.sh` do the work; `.github/workflows/linux-repos.yml` runs them on every published stable release (prereleases skipped: nightlies are prereleases in this same repo). It waits for the conductor's deb and rpm assets to appear before starting, and holds the signing key behind the `release` environment's reviewers.
- [x] Document the `apt` and `dnf` setup steps in `README.md`, and the key handling, hosting reasoning and test recipe in `packaging/linux-repos/README.md`.
- [x] **Verify:** both repositories were built from the real v0.12.6 packages with a throwaway key and consumed in containers.
  - apt (`debian:trixie`): `apt update` accepted the signed `InRelease`, `apt-cache policy` showed 0.12.6 as the candidate, `apt install agent-orchestrator` installed it, and `ao --version` worked.
  - dnf (`fedora:latest`): metadata on one origin and the `.rpm` on another, exactly like the real split. `dnf install` installed the package, and the access log on the second origin proves `xml:base` sent the client there for it.
  - Tampering is refused, which matters more than the happy path. apt: a corrupted `.deb` gives "Some files failed to download" with the hash mismatch, and metadata re-signed by an untrusted key gives "The repository ... is not signed". dnf: a corrupted `.rpm` gives "Downloading successful, but checksum doesn't match", and metadata re-signed by an untrusted key gives "repomd.xml GPG signature verification error: Signing key not found", after which the package is no longer installable from the repository.
  - Not covered: a real end-to-end `apt upgrade` across two published releases, which needs the signing key configured and a release cut. That is the first thing to run once `LINUX_SIGNING_KEY` exists.
- [ ] **Left for a repo admin:** generate the archive signing key and add `LINUX_SIGNING_KEY` to the `release` environment (recipe in `packaging/linux-repos/README.md`). Until then the workflow fails fast with that instruction instead of publishing something unsigned.

---

## Documentation (after A and B)

- [x] Add an Arch row to the install table in `README.md`, pointing at `packaging/arch/README.md`.
- [x] Say how updates work for each format, as a table: macOS, Windows and the AppImage update themselves; deb and rpm are manual; Arch is `update-pkgbuild.sh && makepkg -si`. Plus the reason a package-manager install never self-updates.
- [x] Note that all Linux artifacts are x86_64 only.
- Also removed the claim that "AO checks for updates automatically" from the line above the table, which stopped being true for three of the seven rows.

## Things that could go wrong

- **The package contents are assumed, not confirmed.** A1 and B1 both start by unpacking a real deb and rpm and listing them. Every path in this document rests on that.
- **The name `ao` may already be taken.** Claiming `/usr/bin/ao` across three distro families is hard to undo once users have it installed. Check before shipping.
- **AO could appear twice in the menu.** A3 makes the AppImage entry visible; B4 ships a packaged one. A machine that did both sees two entries. B4's decision step has to cover it.
- **The Arch package goes stale.** It is pinned to a release tag, and AO releases often (`v0.12.6` shipped while this plan was being written). B5's script is the fix; B6 decides who runs it.

## Open questions

1. ~~**AUR: publish publicly, or keep the recipe in the repo only?**~~ Answered in B6: repo only for now, revisit after living with the local install.
2. ~~**Do Phase C at all?**~~ Answered: yes, hosted on GitHub itself. See Phase C for the shape and the one admin step left.
3. ~~**Is `/usr/bin/ao` safe to claim?**~~ Answered in A1: nothing owns it in Debian, Fedora or Arch.
4. **Does ARM matter?** There is no arm64 Linux artifact to install or repackage, because the build matrix has only `linux-x64`. Adding an arm64 build is separate work.
5. **Flatpak instead?** One universal package could replace Phases B and C, at the cost of Flathub review and sandbox work for an app that spawns agent CLIs, git and terminals. Worth revisiting if per-distro packaging turns out to be too much upkeep.

## Found along the way, not fixed here

- **Release builds do not stamp a version.** `ao --version` prints `ao version dev` from the deb published as v0.12.6.
- **The rpm claims the wrong license.** `frontend/forge.config.ts` passes `license: "MIT"` to the rpm maker; the repo is Apache-2.0.
