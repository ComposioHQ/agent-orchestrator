package portscan

import (
	"strconv"
	"strings"
)

// procTCPListen is the st column value for TCP_LISTEN in /proc/net/tcp.
const procTCPListen = "0A"

// parseProcNetTCP maps socket inode -> local port for every listening row of a
// /proc/net/tcp or /proc/net/tcp6 table. The header row and every non-listening
// connection are skipped, as is any row whose port or inode does not parse:
// this table is a suggestion source, so a malformed row is dropped rather than
// failing the whole scan.
func parseProcNetTCP(table string) map[uint64]int {
	out := map[uint64]int{}
	for _, line := range strings.Split(table, "\n") {
		fields := strings.Fields(line)
		// sl local_address rem_address st tx_rx tr retrnsmt uid timeout inode
		if len(fields) < 10 || fields[3] != procTCPListen {
			continue
		}
		_, hexPort, ok := strings.Cut(fields[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseUint(hexPort, 16, 32)
		if err != nil || port == 0 || port > 65535 {
			continue
		}
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil || inode == 0 {
			continue
		}
		out[inode] = int(port)
	}
	return out
}

// parseSocketLink extracts the inode from a /proc/<pid>/fd symlink target.
// Socket descriptors read as "socket:[12345]"; regular files, pipes and
// anonymous inodes are not sockets and are skipped.
func parseSocketLink(target string) (uint64, bool) {
	rest, ok := strings.CutPrefix(target, "socket:[")
	if !ok {
		return 0, false
	}
	rest, ok = strings.CutSuffix(rest, "]")
	if !ok {
		return 0, false
	}
	inode, err := strconv.ParseUint(rest, 10, 64)
	if err != nil || inode == 0 {
		return 0, false
	}
	return inode, true
}
