#!/usr/bin/env bash
# Build a signed flat apt repository for one AO release.
#
# The packages themselves stay on GitHub Releases: a .deb is ~140 MB and GitHub
# Pages rejects any file over 100 MB, and apt resolves a Packages entry's
# Filename relative to the repository base, so metadata and package have to sit
# at the same URL. That base is the release download directory, and every file
# this script produces is uploaded there as a release asset:
#
#   deb [signed-by=...] https://github.com/<repo>/releases/latest/download/ ./
#
# Authenticity chain: the detached and inline signatures cover Release, Release
# carries the SHA-256 of Packages, and Packages carries the SHA-256 of the .deb.
# Nothing needs the .deb itself to be signed (apt has no such concept anyway).
#
# Usage:
#   build-apt-repo.sh --deb <file> --out <dir> --key <gpg key id> [--suite <name>]
set -euo pipefail

deb=""
out=""
key=""
suite="./"
origin="Agent Orchestrator"
while [[ $# -gt 0 ]]; do
	case "$1" in
		--deb) deb="$2"; shift 2 ;;
		--out) out="$2"; shift 2 ;;
		--key) key="$2"; shift 2 ;;
		--suite) suite="$2"; shift 2 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[[ -n "$deb" && -n "$out" && -n "$key" ]] || {
	echo "usage: $0 --deb <file> --out <dir> --key <gpg key id>" >&2
	exit 2
}
for tool in dpkg-scanpackages apt-ftparchive gpg; do
	command -v "$tool" >/dev/null || { echo "$tool is required (dpkg-dev, apt-utils, gnupg)" >&2; exit 1; }
done

mkdir -p "$out"
# The asset name is part of the repository: Filename below points at it, and
# `releases/latest/download/<name>` is the URL apt fetches.
install -m 0644 "$deb" "$out/agent-orchestrator-linux-x64.deb"

cd "$out"
# --multiversion keeps every deb in the directory; there is one today, but the
# flag means adding a second architecture later does not silently drop one.
# /dev/null is the (unused) override file positional argument.
dpkg-scanpackages --multiversion . /dev/null > Packages.raw
# dpkg-scanpackages writes "Filename: ./foo.deb". Strip the "./" so the URL apt
# builds is the plain release-download URL with no redundant segment.
sed 's|^Filename: \./|Filename: |' Packages.raw > Packages
rm -f Packages.raw
gzip -9 -k -f Packages

# A flat repository names its suite "./". Valid-Until is deliberately unset:
# releases can be weeks apart, and an expired Release turns every apt update
# into an error even when nothing is wrong.
apt-ftparchive \
	-o "APT::FTPArchive::Release::Origin=$origin" \
	-o "APT::FTPArchive::Release::Label=$origin" \
	-o "APT::FTPArchive::Release::Suite=$suite" \
	-o "APT::FTPArchive::Release::Codename=$suite" \
	-o "APT::FTPArchive::Release::Architectures=amd64" \
	-o "APT::FTPArchive::Release::Components=main" \
	-o "APT::FTPArchive::Release::Description=Agent Orchestrator desktop app" \
	release . > Release

# Both signature forms: InRelease is what modern apt fetches, Release.gpg is the
# fallback older clients still ask for.
gpg --batch --yes --default-key "$key" --clearsign --output InRelease Release
gpg --batch --yes --default-key "$key" --detach-sign --armor --output Release.gpg Release
# The public key users install into /usr/share/keyrings, shipped beside the
# metadata so the setup instructions are one curl.
gpg --batch --yes --export --armor "$key" > ao-archive-keyring.asc

echo "apt repository written to $out:"
ls -1
