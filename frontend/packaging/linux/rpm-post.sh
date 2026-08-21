# Link the bundled AO CLI onto PATH after an rpm install or upgrade.
#
# Same reasoning as deb-postinst.sh: the generated spec's %files list is fixed
# (launcher, app dir, desktop file, docs, icon), so an extra /usr/bin/ao in the
# buildroot would fail the build as an unpackaged file. rpm-postun.sh removes it.
#
# $1 is 1 on first install and 2 or more on upgrade; link in both cases.
target=/usr/lib/agent-orchestrator/resources/daemon/ao
link=/usr/bin/ao

if [ -e "$link" ] || [ -L "$link" ]; then
	if [ "$(readlink "$link" 2>/dev/null || true)" != "$target" ]; then
		exit 0
	fi
fi
ln -sfn "$target" "$link"
exit 0
