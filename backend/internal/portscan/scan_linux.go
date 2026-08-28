//go:build linux

package portscan

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
)

// listeners resolves ports without spawning anything: the kernel already
// publishes every listening socket in /proc/net/tcp, and /proc/<pid>/fd names
// the sockets each process holds. Both sides are keyed by inode, so the match
// is two small file reads plus one directory listing per caller-supplied pid.
// That keeps a polling caller cheap enough that no OS-level "port opened"
// event is needed (none exists unprivileged on any platform AO ships to).
func listeners(_ context.Context, want map[int]bool) []boundPort {
	ports := map[uint64]int{}
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		data, err := os.ReadFile(table)
		if err != nil {
			continue
		}
		for inode, port := range parseProcNetTCP(string(data)) {
			ports[inode] = port
		}
	}
	if len(ports) == 0 {
		return nil
	}
	var found []boundPort
	for pid := range want {
		for _, inode := range socketInodes(pid) {
			if port, ok := ports[inode]; ok {
				found = append(found, boundPort{PID: pid, Port: port})
			}
		}
	}
	return found
}

// socketInodes lists the socket inodes held by pid. An unreadable directory
// (the process exited mid-scan, or runs as another user) contributes nothing
// rather than failing the scan for every other pid.
func socketInodes(pid int) []uint64 {
	dir := "/proc/" + strconv.Itoa(pid) + "/fd"
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var inodes []uint64
	for _, entry := range entries {
		target, err := os.Readlink(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		if inode, ok := parseSocketLink(target); ok {
			inodes = append(inodes, inode)
		}
	}
	return inodes
}
