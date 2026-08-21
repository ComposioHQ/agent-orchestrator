#!/usr/bin/env bash
# Bump packaging/arch to a released AO version.
#
# Reads the latest release tag from GitHub (or takes one as an argument),
# rewrites pkgver, re-downloads the deb and the LICENSE to recompute their
# checksums, and regenerates .SRCINFO. Run it from anywhere; it edits the files
# next to itself and leaves the downloads in a temp directory.
#
# Usage:
#   ./update-pkgbuild.sh            # latest stable release
#   ./update-pkgbuild.sh 0.12.7     # a specific version, with or without the v
set -euo pipefail

readonly repo='Untrivial-ai/agent-orchestrator'
readonly here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for tool in gh curl sha256sum makepkg; do
	command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

version="${1:-}"
if [[ -z "$version" ]]; then
	# --exclude-pre-releases: nightlies are tagged in the same repo and must
	# never become the pinned version.
	version="$(gh release list --repo "$repo" --exclude-pre-releases --limit 1 --json tagName -q '.[0].tagName')"
fi
version="${version#v}"
[[ -n "$version" ]] || { echo "could not determine a release version" >&2; exit 1; }

current="$(sed -n 's/^pkgver=//p' "$here/PKGBUILD")"
if [[ "$current" == "$version" ]]; then
	echo "already at $version"
	exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

deb_url="https://github.com/$repo/releases/download/v$version/agent-orchestrator-linux-x64.deb"
license_url="https://raw.githubusercontent.com/$repo/v$version/LICENSE"
echo "downloading v$version"
curl -fsSL --retry 3 -o "$work/deb" "$deb_url"
curl -fsSL --retry 3 -o "$work/LICENSE" "$license_url"

deb_sum="$(sha256sum "$work/deb" | cut -d' ' -f1)"
license_sum="$(sha256sum "$work/LICENSE" | cut -d' ' -f1)"

# pkgrel goes back to 1: a new upstream version starts its own release count.
sed -i \
	-e "s/^pkgver=.*/pkgver=$version/" \
	-e "s/^pkgrel=.*/pkgrel=1/" \
	"$here/PKGBUILD"

# Replace the whole sha256sums block rather than editing the two lines in place:
# order matters (it follows source=), and a line-by-line substitution silently
# does the wrong thing if a sum ever repeats.
awk -v deb="$deb_sum" -v license="$license_sum" '
	/^sha256sums=\(/ {
		print "sha256sums=("
		printf "\t\x27%s\x27\n", deb
		printf "\t\x27%s\x27\n", license
		print ")"
		skip = 1
		next
	}
	skip && /^\)/ { skip = 0; next }
	skip { next }
	{ print }
' "$here/PKGBUILD" > "$work/PKGBUILD"
mv "$work/PKGBUILD" "$here/PKGBUILD"

( cd "$here" && makepkg --printsrcinfo > .SRCINFO )

echo "bumped $current -> $version"
echo "build it with: cd $here && makepkg -f"
