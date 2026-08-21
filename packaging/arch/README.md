# Arch package

`agent-orchestrator-bin` installs the AO desktop app on Arch (and derivatives)
the way any other app installs: an entry in the applications menu, the
`agent-orchestrator` launcher and the `ao` CLI on your PATH, and pacman tracking
every file it put down.

It repackages the official `.deb` rather than building from source. The deb is
already laid out the way Arch wants it, and building from source would pull a
full Go build, a full npm build and a bundled Chromium download onto every
user's machine for a result we already publish as a binary.

## Install

```bash
cd packaging/arch
makepkg -si
```

`makepkg` downloads the pinned release, checks it against `sha256sums`, and
hands the built package to pacman. Only the pacman step asks for a password.

## What it puts where

| Path                                                     | What                                          |
| -------------------------------------------------------- | --------------------------------------------- |
| `/usr/lib/agent-orchestrator/`                             | The app, exactly as the deb ships it          |
| `/usr/bin/agent-orchestrator`                              | Launcher (symlink into the directory above)   |
| `/usr/bin/ao`                                              | The `ao` CLI (the daemon binary is the CLI)   |
| `/usr/share/applications/agent-orchestrator.desktop`       | Menu entry, and the `ao-app://` handler       |
| `/usr/share/icons/hicolor/1024x1024/apps/`                 | The menu icon                                 |
| `/usr/share/licenses/agent-orchestrator-bin/`              | AO's Apache-2.0 license, and Electron's MIT   |

Nothing is written to `~/.ao`. The app creates its own state on first launch,
exactly as it does for every other install method.

## Check it worked

```bash
ao --version                      # the CLI is on PATH
pacman -Qkk agent-orchestrator-bin  # 0 altered files, including chrome-sandbox's setuid bit
```

Then open Agent Orchestrator from the applications menu. It should start with no
terminal window and no `SUID sandbox helper` error.

## Updating

The package pins one release, so a new AO release needs a bump:

```bash
./update-pkgbuild.sh          # latest stable release
./update-pkgbuild.sh 0.12.7   # or a specific version
makepkg -si
```

The script rewrites `pkgver`, recomputes both checksums against the freshly
downloaded files, and regenerates `.SRCINFO`.

Auto-updates stay off on a package install: the app cannot write to `/usr/lib`,
and overwriting files pacman tracks would leave its database disagreeing with
the disk. The Settings panel says so instead of failing quietly.

## Removing

```bash
sudo pacman -Rns agent-orchestrator-bin
```

`-Rns` also removes dependencies nothing else needs. To confirm nothing is left
behind:

```bash
ls /usr/lib/agent-orchestrator /usr/bin/ao   # both gone
pacman -Qo /usr/share/applications/agent-orchestrator.desktop  # owned by no package
```

Your `~/.ao` directory is untouched by install and removal alike, so sessions,
projects and settings survive.

## Publishing to the AUR

Not published yet. `PKGBUILD` and `.SRCINFO` live here so anyone can build the
package from a checkout; publishing them to the AUR is a public promise to bump
the version on every AO release, which is a decision to make separately.
