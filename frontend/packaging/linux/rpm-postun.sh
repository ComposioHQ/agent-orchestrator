# Remove the /usr/bin/ao link created by rpm-post.sh.
#
# $1 is 0 only on the final erase; on an upgrade it is 1 or more and the new
# package's %post recreates the link, so leave it in place there.
target=/usr/lib/agent-orchestrator/resources/daemon/ao
link=/usr/bin/ao

if [ "$1" = 0 ]; then
	if [ "$(readlink "$link" 2>/dev/null || true)" = "$target" ]; then
		rm -f "$link"
	fi
fi
exit 0
