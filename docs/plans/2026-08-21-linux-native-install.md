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

### Phase C: updates for .deb and .rpm (only if we want the commitment)

Problem 4. Fixing it means hosting signed `apt` and `dnf` repositories, which is real infrastructure, not just code. Deliberately last.

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

- [ ] Unpack a real released `.deb` and `.rpm` and list what is inside. The Go binary is expected at `usr/lib/agent-orchestrator/resources/daemon/ao`, but confirm it. Every step below depends on the real path, not that guess.
- [ ] Confirm the bundled binary is the full CLI, not just the daemon: `ao --help` should list `preview`, `start` and the rest.
- [ ] Add a `/usr/bin/ao` link to the deb and rpm payloads. `electron-installer-debian` supports extra links through maker options; if it cannot express this, do it in a Forge `postMake` hook instead.
- [ ] Decide whether `ao` is too generic a name to claim. Check the Debian, Fedora and Arch official repositories for a package that already installs `/usr/bin/ao`. If one exists, ship `agent-orchestrator-cli` and only link `ao` where it is free.
- [ ] AppImage users cannot get a PATH entry from a single file. Document the workaround (extract the binary, or use `ao start`).
- [ ] **Verify:** on a fresh deb install and a fresh rpm install, `ao --version` and `ao preview https://example.com` both work in a new shell.

### A2. Stop package-manager installs from self-updating

*Why: so a `.deb` install does not try to overwrite root-owned files (problem 3).*

- [ ] Add a check to `frontend/src/main/auto-updater.ts`: this is a package-manager install when `process.env.APPIMAGE` is unset **and** the app's own folder is not writable by the current user. Keep it as a small exported function so it can be unit tested.
- [ ] Call it from `initAutoUpdates()` in `frontend/src/main.ts:1963`, next to the existing `!app.isPackaged` early return.
- [ ] Add tests in `frontend/src/main/auto-updater.test.ts` for three cases: AppImage (updates), writable folder such as macOS `/Applications` or a Windows per-user install (updates), root-owned folder (does not update).
- [ ] Show it in the app's update panel instead of failing quietly: "Installed by your system package manager. Update with your package manager." Add that string to all 8 files under `frontend/src/renderer/i18n/`.
- [ ] **Verify:** tests pass; a real deb install shows the message instead of downloading; an AppImage run still self-updates exactly as before.

### A3. Give the AppImage a real menu entry

*Why: so AppImage users stop hand-writing `.desktop` files (problem 2).*

- [ ] `ao start` already writes `agent-orchestrator-ao-app.desktop` (see `backend/internal/cli/start.go`). Turn it into a real menu entry: remove `NoDisplay=true`, add `Icon`, `Categories=Development;` and a `Comment`.
- [ ] Get an icon onto disk so `Icon=` can name it rather than point at an absolute path. Extract it from the AppImage, or ship it next to the downloaded binary under `~/.ao`, then install it into `~/.local/share/icons/hicolor/`.
- [ ] Keep the existing `Exec` quoting done by `desktopExecPath`. `backend/internal/cli/start_test.go:283` covers a path containing a space and a `%`; that test must stay green.
- [ ] Run `update-desktop-database` after writing the file, the same way the code already runs `xdg-mime`.
- [ ] **Verify:** after `ao start` on a machine with no AO installed, AO appears in the applications menu with its icon and opens on click, with no terminal window.

---

## Phase B: the Arch package

### B1. Write the PKGBUILD

*Why: so Arch users can `makepkg -si` instead of juggling an AppImage.*

- [ ] Create `packaging/arch/PKGBUILD`: `pkgname=agent-orchestrator-bin`, `pkgver` set to the current release (`0.12.6` as of writing, read the real one with `gh release view --json tagName`), `arch=('x86_64')`, `license=('MIT')`, `url` pointing at the GitHub repo.
- [ ] Add `provides=('agent-orchestrator')` and `conflicts=('agent-orchestrator')`, so a build-from-source package could later share the same name space without colliding.
- [ ] Point `source=` at the released deb: `"$pkgname-$pkgver.deb::https://github.com/Untrivial-ai/agent-orchestrator/releases/download/v$pkgver/agent-orchestrator-linux-x64.deb"`, with a real `sha256sums` value.
- [ ] Work out `depends=` by running `ldd` on the unpacked binary rather than guessing. Expect at least `gtk3`, `nss`, `alsa-lib`, `libxss`, `libnotify`, `xdg-utils`.
- [ ] In `package()`, unpack the deb with `bsdtar -xf data.tar.*` and move `usr/lib`, `usr/bin` and `usr/share` into `$pkgdir/usr/`.
- [ ] **Verify:** `makepkg -f` builds a package, and `pacman -Qlp` on it lists `/usr/bin/agent-orchestrator`, `/usr/bin/ao`, the app under `/usr/lib/agent-orchestrator/`, the `.desktop` file and the icons.

### B2. Fix the sandbox permissions

*Why: without this, Electron refuses to start.*

Electron ships a helper called `chrome-sandbox` that isolates web content from the rest of your machine. Linux requires that helper to be owned by root with a special permission bit (`4755`, "setuid"), or Electron aborts with:

```
The SUID sandbox helper binary was found, but is not configured correctly.
```

- [ ] In `package()`, run `chmod 4755 "$pkgdir/usr/lib/agent-orchestrator/chrome-sandbox"`.
- [ ] Do **not** work around this by adding `--no-sandbox` to the launcher. Arch has the kernel feature the sandbox needs enabled by default, so the sandbox works. Disabling it quietly removes a security boundary.
- [ ] **Verify:** the installed app starts with no sandbox error printed, and `pacman -Qkk agent-orchestrator-bin` reports no permission mismatch.

### B3. Check the bundled runtimes survive a read-only install

*Why: `/usr/lib` is root-owned, and AO bundles helper programs that might expect to write next to themselves.*

- [ ] AO ships two extra runtimes: a browser runtime (`frontend/scripts/prepare-agent-browser.mjs`) and an ACP runtime (`frontend/scripts/build-acp-runtime.mjs`). If either writes into its own folder, it breaks under `/usr/lib`.
- [ ] Actually exercise both on an installed build, not just launch the app: open the inspector rail's Browser tab, and start a session using an ACP agent.
- [ ] If either needs to write, move its scratch folder under `~/.ao` (which the `CLAUDE.md` rule requires anyway) rather than making `/usr/lib` writable.
- [ ] **Verify:** both runtimes work from a pacman install.

### B4. Menu entry, icon, and the `ao-app://` link handler

*Why: two different `.desktop` files could end up claiming the same links.*

- [ ] Check the deb's own `/usr/share/applications/agent-orchestrator.desktop` is still correct after being moved: `Exec` should point at `/usr/bin/agent-orchestrator`, `Icon` should be the icon *name* (not a path), `Terminal=false`, and `MimeType` should include `x-scheme-handler/ao-app`. `forge.config.ts` already passes that mime type to the deb maker, so it should be there.
- [ ] Create `packaging/arch/agent-orchestrator-bin.install` that runs `update-desktop-database` and `gtk-update-icon-cache` on install, upgrade and removal. Without this the menu and icon do not refresh.
- [ ] Resolve the clash with the user-level entry `ao start` writes, which A3 makes visible. If both exist, AO shows up twice in the menu and the system picks an `ao-app://` handler arbitrarily. Decide whether the packaged entry should win, and whether `ao start` should skip writing its own when a system install is present. Write the decision down. Do **not** silently delete a file the package does not own.
- [ ] **Verify:** AO appears once in the menu with its icon, opens on click with no terminal, and `xdg-open ao-app://test` reaches the app exactly once.

### B5. A script to bump versions, and a test runbook

*Why: a package pinned to `0.10.3` is stale the day `0.10.4` ships.*

- [ ] Write `packaging/arch/update-pkgbuild.sh`: read the latest tag with `gh release view --json tagName`, rewrite `pkgver`, re-download the deb, recompute `sha256sums`, regenerate `.SRCINFO`.
- [ ] Write `packaging/arch/README.md` covering the full loop: `makepkg -si`, launch it, `pacman -Rns agent-orchestrator-bin`, confirm nothing is left behind.
- [ ] **Verify:** install then remove leaves no orphan files (`pacman -Qo` on the old paths finds nothing) and never touched `~/.ao`.

### B6. Publish to the AUR (needs a decision first)

- [ ] Decide whether to publish at all, and under whose account. Publishing to the AUR is a public promise: bump the version on every AO release, or users get stale builds and file bugs.
- [ ] If yes: set up the AUR git remote, push `PKGBUILD` and `.SRCINFO`, and decide whether the release workflow opens a bump PR automatically or a person does it by hand.
- [ ] If no: stop after B5. `packaging/arch/` in the repo still gives anyone a one-command install with `makepkg -si`.

---

## Phase C: updates for .deb and .rpm (needs a decision first)

Only worth doing if AO wants Linux users on a real update path. It needs a GPG signing key and somewhere to host files, so it is an infrastructure commitment, not just code.

- [ ] Decide: host signed `apt` and `dnf` repositories, or accept manual updates for deb/rpm and point users who want auto-updates at the AppImage. Either answer is fine; write it down.
- [ ] If hosting: generate and sign the repository metadata in the release workflow, and publish it. GitHub Pages is the cheapest option that adds no new service.
- [ ] Document the `apt` and `dnf` setup steps in `README.md` next to the direct download links.
- [ ] **Verify:** `apt update && apt upgrade` and `dnf upgrade` each pull a new AO release on a test machine.

---

## Documentation (after A and B)

- [ ] Add an Arch row to the install table in `README.md`, around line 177 next to AppImage, Debian and Fedora.
- [ ] Say how updates work for each format: AppImage updates itself, deb and rpm are manual (or repo-based after Phase C), Arch is `pacman -Syu` once the AUR package is bumped.
- [ ] Note that all Linux artifacts are x86_64 only, and why.

## Things that could go wrong

- **The package contents are assumed, not confirmed.** A1 and B1 both start by unpacking a real deb and rpm and listing them. Every path in this document rests on that.
- **The name `ao` may already be taken.** Claiming `/usr/bin/ao` across three distro families is hard to undo once users have it installed. Check before shipping.
- **AO could appear twice in the menu.** A3 makes the AppImage entry visible; B4 ships a packaged one. A machine that did both sees two entries. B4's decision step has to cover it.
- **The Arch package goes stale.** It is pinned to a release tag, and AO releases often (`v0.12.6` shipped while this plan was being written). B5's script is the fix; B6 decides who runs it.

## Open questions

1. **AUR: publish publicly, or keep the recipe in the repo only?** Decides whether B6 happens and whether we are taking on ongoing maintenance.
2. **Do Phase C at all?** The alternative is telling deb and rpm users to use the AppImage if they want updates.
3. **Is `/usr/bin/ao` safe to claim?** See A1.
4. **Does ARM matter?** There is no arm64 Linux artifact to install or repackage, because the build matrix has only `linux-x64`. Adding an arm64 build is separate work.
5. **Flatpak instead?** One universal package could replace Phases B and C, at the cost of Flathub review and sandbox work for an app that spawns agent CLIs, git and terminals. Worth revisiting if per-distro packaging turns out to be too much upkeep.
