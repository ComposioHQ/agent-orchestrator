# apt and dnf repositories

These give deb and rpm users `apt upgrade` / `dnf upgrade` instead of
downloading a file by hand. `.github/workflows/linux-repos.yml` runs the two
scripts here on every published stable release.

## Where things live, and why

The packages stay on GitHub Releases. A `.deb` is around 140 MB and GitHub Pages
refuses files over 100 MB, so the only question is where the small signed
metadata goes, and each package manager answers it differently.

| | Base URL | Why there |
| --- | --- | --- |
| apt | `.../releases/latest/download/` | apt resolves a package's `Filename` relative to the repository base, so metadata and package must share a base. `latest/download` always resolves to the newest stable release, which is exactly "upgrade to current". |
| dnf | `https://raw.githubusercontent.com/<repo>/linux-repo/dnf/` | dnf needs a `repodata/` subdirectory, which flat release-asset names cannot express. `primary.xml` carries an `xml:base` pointing back at the release, so the `.rpm` still comes from GitHub Releases. |

GitHub Pages would be the conventional host for the dnf metadata, but this
repo's Pages site is the landing page and a second deploy would replace it. The
metadata is a few KB per release, which a raw URL carries comfortably. If that
ever stops being true, moving to Pages (or any static host) is a URL change in
one `.repo` file.

### One quirk of pinning apt to `latest/download`

The metadata and the package both resolve through the same `latest` alias, so
they always describe the same release. If a new release lands in the window
between a user's `apt update` and their `apt install`, the alias moves under
them and apt reports a hash mismatch. Re-running `apt update` fixes it. The
alternative (a per-version base URL) would mean users editing their sources list
on every release, which is the thing this whole setup exists to avoid.

## Signatures

Neither published package is re-signed. The chain runs through the metadata:

```
InRelease / Release.gpg  ->  Release  ->  Packages  ->  the .deb
repomd.xml.asc           ->  repomd.xml  ->  primary.xml  ->  the .rpm
```

Each arrow is a SHA-256 recorded in the file to its left, and the leftmost file
carries the signature. Corrupt any link and the client refuses, which is what
`repo_gpgcheck=1` checks on the dnf side and what apt does by default.

The generated `.repo` guidance sets `gpgcheck=0` deliberately: that flag means
"the .rpm itself carries a signature", and ours does not. Claiming otherwise
would fail every install. Signing the rpm would mean overwriting an already
published release asset, and other things pin those bytes.

## The signing key

The workflow needs one repository secret:

- `LINUX_SIGNING_KEY`: the ASCII-armored **private** key, no passphrase (an
  unattended signer cannot answer a prompt; protect it by keeping it in the
  `release` environment, which is behind required reviewers).

Generate one:

```bash
export GNUPGHOME="$(mktemp -d)"
gpg --batch --quick-generate-key 'Agent Orchestrator <releases@example.com>' \
  default sign never
gpg --armor --export-secret-keys > private.asc   # -> LINUX_SIGNING_KEY secret
gpg --armor --export > public.asc                # published as a release asset
```

Then, in repository Settings > Environments > release, add `LINUX_SIGNING_KEY`.
Keep an offline copy of `private.asc`: rotating the key means every existing
user has to install the new one by hand, which is the one genuinely painful
failure mode here.

Both scripts export the public key next to the metadata, so users always fetch
the key from the same place they fetch the repository.

## Running the scripts by hand

```bash
./build-apt-repo.sh --deb agent-orchestrator-linux-x64.deb --out apt --key <fingerprint>
./build-dnf-repo.sh --rpm agent-orchestrator-linux-x64.rpm --out dnf --key <fingerprint> \
  --location-base https://github.com/Untrivial-ai/agent-orchestrator/releases/download/v0.12.6/
```

`build-apt-repo.sh` needs `dpkg-dev`, `apt-utils` and `gnupg`;
`build-dnf-repo.sh` needs `createrepo_c` and `gnupg`.

## Testing a change to either script

Neither script is exercised by CI, so test them the way they were developed:
build a repository with a throwaway key, serve it over HTTP, and install from it
in a container.

```bash
# apt
docker run --rm -v "$PWD:/work" debian:trixie bash -c '
  apt-get update -qq && apt-get install -y -qq dpkg-dev apt-utils gnupg python3
  export GNUPGHOME=/tmp/gpg && mkdir -p $GNUPGHOME && chmod 700 $GNUPGHOME
  gpg --batch --quick-generate-key --passphrase "" test@example.invalid default default never
  key=$(gpg --list-secret-keys --with-colons | awk -F: "/^fpr:/{print \$10; exit}")
  /work/build-apt-repo.sh --deb /work/agent-orchestrator-linux-x64.deb --out /srv/apt --key "$key"
  cd /srv/apt && python3 -m http.server 8080 & sleep 2
  install -m 0644 /srv/apt/ao-archive-keyring.asc /usr/share/keyrings/ao.asc
  echo "deb [signed-by=/usr/share/keyrings/ao.asc] http://127.0.0.1:8080/ ./" > /etc/apt/sources.list.d/ao.list
  apt-get update && apt-get install -y agent-orchestrator && ao --version'
```

The dnf equivalent serves `repodata/` and the `.rpm` from two different ports,
which is the arrangement that matters: it proves `xml:base` sends the client to
the other host for the package.

Also test the failure paths, because a repository that accepts tampering is
worse than no repository: corrupt the package and confirm the client refuses,
and re-sign the metadata with a different key and confirm it refuses again.
