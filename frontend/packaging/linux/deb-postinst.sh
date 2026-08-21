#!/bin/sh
# Link the bundled AO CLI onto PATH after a dpkg install.
#
# The `ao` CLI and the daemon are the same Go binary, shipped inside the app at
# /usr/lib/agent-orchestrator/resources/daemon/ao. The deb payload itself cannot
# carry this link: electron-installer-debian only emits one /usr/bin symlink,
# for the Electron launcher, and exposes no option for a second one. A postinst
# is the standard fallback, and deb-postrm.sh removes the link again.
#
# Never clobber a /usr/bin/ao owned by something else: if the path already
# exists and does not point at our binary, leave it alone and exit clean.
set -e

target=/usr/lib/agent-orchestrator/resources/daemon/ao
link=/usr/bin/ao

case "$1" in
	configure)
		if [ -e "$link" ] || [ -L "$link" ]; then
			[ "$(readlink "$link" 2>/dev/null || true)" = "$target" ] || exit 0
		fi
		ln -sfn "$target" "$link"
		;;
esac

exit 0
