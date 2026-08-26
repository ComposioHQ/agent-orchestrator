package portscan

import (
	"context"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// maxDetected caps a suggestion list. A session with more listening ports than
// this has something unusual going on, and a toolbar dropdown is not the place
// to enumerate it.
const maxDetected = 20

// Detected is one port a session is serving on, with a display label for the
// process that owns it. Command is a convenience for the reader, never an
// identifier, and may be empty.
type Detected struct {
	Port    int
	PID     int
	Command string
}

// process is one row of the machine's process table.
type process struct {
	PID     int
	PPID    int
	Command string
}

// Detect returns the TCP ports one session is serving on.
//
// A session is identified two ways, and a process qualifies on EITHER:
//
//   - it descends from rootPID, the session's own entry point (a tmux pane's
//     shell, or the provider process a chat session spawned); or
//   - its working directory is inside workspace, the session's worktree.
//
// The second anchor is not redundant. Agents routinely start a dev server in
// the background, and a backgrounded process calls setsid and is reparented to
// init the moment its launching shell exits. From then on it descends from
// nothing AO owns, so tree scoping alone reports nothing. Its working directory
// does not move, and a worktree belongs to exactly one session, so cwd keeps
// the scan correctly scoped after the tree connection is gone.
//
// Best effort throughout: an unreadable process table, a missing enumeration
// tool, or a permission denial all yield an empty list rather than an error,
// because "no suggestions" is a normal outcome that every caller renders.
func Detect(ctx context.Context, rootPID int, workspace string) []Detected {
	procs := processTable(ctx)
	if len(procs) == 0 {
		return nil
	}
	candidates := map[int]bool{}
	if rootPID > 0 {
		for pid := range descendants(procs, rootPID) {
			candidates[pid] = true
		}
	}
	for _, pid := range workspaceProcesses(ctx, procs, workspace) {
		candidates[pid] = true
	}
	if len(candidates) == 0 {
		return nil
	}
	pids := make([]int, 0, len(candidates))
	for pid := range candidates {
		pids = append(pids, pid)
	}
	return attribute(procs, rootPID, ownedListeners(ctx, pids))
}

// underWorkspace reports whether cwd is the workspace directory or inside it.
// A plain string prefix would let "/w/app-old" match a workspace of "/w/app",
// so the boundary must fall on a separator.
func underWorkspace(cwd, workspace string) bool {
	if cwd == "" || workspace == "" {
		return false
	}
	if cwd == workspace {
		return true
	}
	prefix := strings.TrimSuffix(workspace, string(filepath.Separator)) + string(filepath.Separator)
	return strings.HasPrefix(cwd, prefix)
}

// descendants is rootPID plus every process beneath it, by repeated sweeps over
// the table until nothing new is adopted. The table is a snapshot, so a process
// whose parent exited is simply absent from the tree rather than reparented.
func descendants(procs []process, rootPID int) map[int]bool {
	tree := map[int]bool{rootPID: true}
	for changed := true; changed; {
		changed = false
		for _, proc := range procs {
			if tree[proc.PID] || !tree[proc.PPID] {
				continue
			}
			tree[proc.PID] = true
			changed = true
		}
	}
	return tree
}

// attribute turns raw (pid, port) pairs into one entry per port.
//
// A server started from a shell is normally reported several times over: the
// child inherits the listening descriptor, so the shell, the package runner and
// the server itself all hold it. When several processes claim one port the
// DEEPEST in the tree wins — that is the process that actually bound it
// (`next-server`), not the wrapper that spawned it (`zsh`, `bun`), and it is
// also the more useful label to show.
func attribute(procs []process, rootPID int, listeners []boundPort) []Detected {
	if len(listeners) == 0 {
		return nil
	}
	parents := make(map[int]int, len(procs))
	commands := make(map[int]string, len(procs))
	for _, proc := range procs {
		parents[proc.PID] = proc.PPID
		commands[proc.PID] = proc.Command
	}
	owners := make(map[int]int, len(listeners))
	order := make([]int, 0, len(listeners))
	for _, listener := range listeners {
		current, claimed := owners[listener.Port]
		if !claimed {
			order = append(order, listener.Port)
		}
		// Depth only orders processes that are IN the tree. A reparented server
		// reaches no root, so every candidate for its port ties at -1 and the
		// first one seen keeps it -- correct, because there is no ancestry left
		// to prefer one over another.
		if !claimed || depth(parents, listener.PID, rootPID) > depth(parents, current, rootPID) {
			owners[listener.Port] = listener.PID
		}
	}
	sort.Ints(order)
	if len(order) > maxDetected {
		order = order[:maxDetected]
	}
	out := make([]Detected, 0, len(order))
	for _, port := range order {
		pid := owners[port]
		out = append(out, Detected{Port: port, PID: pid, Command: commandLabel(commands[pid])})
	}
	return out
}

// depth counts the hops from pid up to rootPID. A pid whose ancestry does not
// reach the root (its parent exited between the snapshot and the socket scan,
// or the chain loops) scores lowest, so it never displaces a process whose
// ancestry is known.
func depth(parents map[int]int, pid, rootPID int) int {
	for hops := 0; hops <= len(parents); hops++ {
		if pid == rootPID {
			return hops
		}
		parent, ok := parents[pid]
		if !ok || parent <= 0 {
			return -1
		}
		pid = parent
	}
	return -1
}

// genericRuntimes are executables that say nothing about what is being served.
// For these the first real argument is the informative half of the command, so
// "node .../next/dist/bin/next" labels as "next" rather than "node".
var genericRuntimes = map[string]bool{
	"bash": true, "bun": true, "deno": true, "node": true, "perl": true,
	"php": true, "python": true, "python2": true, "python3": true, "ruby": true,
	"sh": true, "zsh": true,
}

// commandLabel shortens a full argv line to something worth showing next to a
// port number.
func commandLabel(command string) string {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return ""
	}
	label := filepath.Base(fields[0])
	if !genericRuntimes[label] {
		return label
	}
	for _, field := range fields[1:] {
		if strings.HasPrefix(field, "-") {
			continue
		}
		if arg := filepath.Base(field); arg != "" && arg != "." && arg != "/" {
			return trimScriptExt(arg)
		}
	}
	return label
}

// trimScriptExt drops a JavaScript entry-point suffix so a bin script reads as
// "vite" rather than "vite.js". Only these extensions are stripped: a module
// name like "http.server" is not a filename and must survive intact.
func trimScriptExt(arg string) string {
	for _, ext := range []string{".mjs", ".cjs", ".js"} {
		if trimmed, ok := strings.CutSuffix(arg, ext); ok && trimmed != "" {
			return trimmed
		}
	}
	return arg
}

// parseProcessTable reads `pid ppid args` rows. A row that does not parse is
// skipped rather than failing the scan: one unreadable process must not cost
// the caller every other suggestion.
func parseProcessTable(out string) []process {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	procs := make([]process, 0, len(lines))
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid <= 0 {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil || ppid < 0 {
			continue
		}
		procs = append(procs, process{PID: pid, PPID: ppid, Command: strings.Join(fields[2:], " ")})
	}
	return procs
}
