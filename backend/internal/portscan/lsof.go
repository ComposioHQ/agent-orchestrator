package portscan

import (
	"sort"
	"strconv"
	"strings"
)

// lsofArgs builds the listening-socket query for pids.
//
//   - -nP suppresses DNS and /etc/services lookups, so a NAME field is always
//     numeric host:port and never blocks on a resolver.
//   - -a -p <list> restricts the scan to the caller's own process set instead
//     of enumerating every socket on the machine.
//   - -F pn selects machine-readable field output. lsof's default column
//     layout differs between macOS and Linux builds; the field format does not.
func lsofArgs(pids []int) []string {
	list := make([]string, 0, len(pids))
	for _, pid := range pids {
		list = append(list, strconv.Itoa(pid))
	}
	sort.Strings(list)
	return []string{"-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", strings.Join(list, ","), "-F", "pn"}
}

// parseLsof reads lsof -F field output: one field per line, first byte naming
// the field. A "p" line opens a process block and every following "n" line is
// one of that process's sockets. want re-filters the pids because -p is a
// request, not a guarantee -- an lsof build that ignores or widens it must not
// leak another session's ports into the result.
func parseLsof(out string, want map[int]bool) []boundPort {
	var found []boundPort
	pid := 0
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 2 {
			continue
		}
		value := strings.TrimSpace(line[1:])
		switch line[0] {
		case 'p':
			pid = 0
			if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
				pid = parsed
			}
		case 'n':
			if pid == 0 || !want[pid] {
				continue
			}
			if port, ok := parseListenPort(value); ok {
				found = append(found, boundPort{PID: pid, Port: port})
			}
		}
	}
	return found
}

// parseListenPort pulls the port out of an lsof NAME field. Under -n the field
// is "127.0.0.1:5173", "[::1]:5173" or "*:5173", optionally followed by a
// parenthesized state, so the port is what follows the last colon.
func parseListenPort(name string) (int, bool) {
	name, _, _ = strings.Cut(strings.TrimSpace(name), " ")
	idx := strings.LastIndex(name, ":")
	if idx < 0 {
		return 0, false
	}
	port, err := strconv.Atoi(name[idx+1:])
	if err != nil || port <= 0 || port > 65535 {
		return 0, false
	}
	return port, true
}
