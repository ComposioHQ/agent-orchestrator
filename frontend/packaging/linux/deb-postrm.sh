#!/bin/sh
# Remove the /usr/bin/ao link created by deb-postinst.sh.
#
# Only on an actual removal, not on the postrm call that precedes an upgrade,
# and only when the link still points at our binary (readlink is not resolved
# with -f here: by the time postrm runs the target file is already gone).
set -e

target=/usr/lib/agent-orchestrator/resources/daemon/ao
link=/usr/bin/ao

case "$1" in
	remove | purge)
		if [ "$(readlink "$link" 2>/dev/null || true)" = "$target" ]; then
			rm -f "$link"
		fi
		;;
esac

exit 0
