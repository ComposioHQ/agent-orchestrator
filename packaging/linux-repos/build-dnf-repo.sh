#!/usr/bin/env bash
# Build signed dnf repository metadata for one AO release.
#
# Only the metadata is produced here. The .rpm stays on GitHub Releases, so
# primary.xml records its location with an xml:base pointing at the release
# download URL (createrepo_c's --location-base), and the metadata is small
# enough to serve from GitHub Pages.
#
# Authenticity chain: repomd.xml.asc signs repomd.xml, repomd.xml carries the
# SHA-256 of primary.xml, and primary.xml carries the SHA-256 and size of the
# .rpm. That is what repo_gpgcheck=1 verifies. The published .rpm is not itself
# signed, so the generated .repo file sets gpgcheck=0 and repo_gpgcheck=1
# rather than claiming a package signature that does not exist.
#
# Usage:
#   build-dnf-repo.sh --rpm <file> --out <dir> --key <gpg key id> --location-base <url>
set -euo pipefail

rpm_file=""
out=""
key=""
location_base=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--rpm) rpm_file="$2"; shift 2 ;;
		--out) out="$2"; shift 2 ;;
		--key) key="$2"; shift 2 ;;
		--location-base) location_base="$2"; shift 2 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[[ -n "$rpm_file" && -n "$out" && -n "$key" && -n "$location_base" ]] || {
	echo "usage: $0 --rpm <file> --out <dir> --key <gpg key id> --location-base <url>" >&2
	exit 2
}
for tool in createrepo_c gpg; do
	command -v "$tool" >/dev/null || { echo "$tool is required (createrepo_c, gnupg)" >&2; exit 1; }
done

# createrepo_c indexes a directory of rpms. Stage the release asset under the
# name it has on the release, then delete it: what ships is repodata/ only, and
# the href recorded in primary.xml is that same name resolved against
# --location-base.
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
install -m 0644 "$rpm_file" "$staging/agent-orchestrator-linux-x64.rpm"

# -u/--baseurl becomes the xml:base on every <location> in primary.xml, which
# is what lets the .rpm live on a different host than this metadata.
# --general-compress-type, not --compress-type: the latter only covers the
# extra metadata files and leaves primary/filelists/other on the modern zstd
# default, which older dnf and yum clients cannot read. These files are a few
# KB either way.
createrepo_c --quiet --general-compress-type gz --baseurl "$location_base" "$staging"

mkdir -p "$out"
rm -rf "$out/repodata"
cp -r "$staging/repodata" "$out/repodata"

gpg --batch --yes --default-key "$key" --detach-sign --armor \
	--output "$out/repodata/repomd.xml.asc" "$out/repodata/repomd.xml"
gpg --batch --yes --export --armor "$key" > "$out/ao-archive-keyring.asc"

echo "dnf metadata written to $out:"
find "$out" -type f | sort
