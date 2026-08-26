package tmux

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
)

// syncCurrentEnvironment refreshes one tmux session's process-launch
// environment from the daemon before its real pane is created or respawned.
// tmux sessions snapshot the server environment, so a server which survives an
// app restart otherwise keeps stale credentials, PATH entries, and socket
// locations forever. Session-specific inspection also catches values which
// were added only to this session and later removed.
//
// Values are sent through `source-file -` on stdin. They must never be added to
// tmux argv: command lines are visible to other local processes on several
// supported operating systems. Existing names are also inspected so variables
// removed from the daemon environment are explicitly removed from tmux.
func (r *Runtime) syncCurrentEnvironment(ctx context.Context, sessionID string, configured map[string]string) error {
	current := sessionWorkloadEnvironment(os.Environ(), configured)
	names := make(map[string]struct{}, len(current))
	for key := range current {
		names[key] = struct{}{}
	}
	queries := []struct {
		scope string
		args  []string
	}{
		{scope: "global", args: []string{"show-environment", "-g"}},
		{scope: "session", args: []string{"show-environment", "-t", exactSessionTarget(sessionID)}},
	}
	for _, query := range queries {
		out, err := r.runForSession(ctx, sessionID, query.args...)
		if err != nil {
			if serverUnreachableOutput(string(out)) {
				return fmt.Errorf("tmux server unavailable while refreshing session %s", sessionID)
			}
			return fmt.Errorf("inspect tmux %s environment %s: %w", query.scope, sessionID, err)
		}
		for _, key := range parseTmuxEnvironmentNames(string(out)) {
			names[key] = struct{}{}
		}
	}

	script := buildEnvironmentSyncScript(current, names, sessionID)
	if script == "" {
		return nil
	}
	if _, err := r.runWithInputForSession(ctx, sessionID, []byte(script), "source-file", "-"); err != nil {
		return fmt.Errorf("apply tmux session environment: %w", err)
	}
	return nil
}

// sessionWorkloadEnvironment applies the existing RuntimeConfig environment
// semantics without putting any configured value in a command line. An absent
// NO_COLOR is removed even when AO itself inherited it; COLORTERM and TERM stay
// owned by AO/tmux; and an empty configured PATH retains the ambient PATH, as
// the historical launch command did.
func sessionWorkloadEnvironment(base []string, configured map[string]string) map[string]string {
	result := currentWorkloadEnvironment(base)
	if _, configuredNoColor := configured["NO_COLOR"]; !configuredNoColor {
		delete(result, "NO_COLOR")
	}
	for key, value := range configured {
		if key == "TERM" || key == "COLORTERM" || isolatedTmuxEnvironmentKey(key) {
			continue
		}
		if key == "PATH" && value == "" {
			continue
		}
		result[key] = value
	}
	result["COLORTERM"] = "truecolor"
	return result
}

// currentWorkloadEnvironment is the subset of the daemon environment that
// tmux should use for future panes. TERM is deliberately omitted because tmux
// owns the TERM value inside panes; COLORTERM and ordinary workload variables
// remain current. controlEnv has already removed the surrounding tmux identity
// and AO's internal binary/socket selectors.
func currentWorkloadEnvironment(base []string) map[string]string {
	result := make(map[string]string)
	for _, entry := range controlEnv(base) {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "TERM" || !validEnvKey(key) {
			continue
		}
		result[key] = value
	}
	return result
}

func isolatedTmuxEnvironmentKey(key string) bool {
	switch key {
	case "TMUX", "TMUX_PANE", "AO_TMUX_BINARY", "AO_TMUX_SOCKET_NAME":
		return true
	default:
		return false
	}
}

// parseTmuxEnvironmentNames extracts names from global or session
// `show-environment` output. Removed entries are emitted as -NAME; ordinary
// entries are NAME=value. Values are intentionally discarded and never copied
// into argv or errors.
func parseTmuxEnvironmentNames(output string) []string {
	seen := make(map[string]struct{})
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSuffix(line, "\r")
		var key string
		if strings.HasPrefix(line, "-") {
			key = strings.TrimPrefix(line, "-")
		} else if before, _, ok := strings.Cut(line, "="); ok {
			key = before
		}
		if key == "TERM" || !validEnvKey(key) {
			continue
		}
		seen[key] = struct{}{}
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func buildEnvironmentSyncScript(current map[string]string, names map[string]struct{}, sessionID string) string {
	keys := make([]string, 0, len(names))
	for key := range names {
		if key == "TERM" || !validEnvKey(key) {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var script strings.Builder
	for _, key := range keys {
		value, present := current[key]
		if present {
			fmt.Fprintf(&script, "set-environment -t %s %s %s\n", exactSessionTarget(sessionID), key, tmuxConfigQuote(value))
			continue
		}
		fmt.Fprintf(&script, "set-environment -r -t %s %s\n", exactSessionTarget(sessionID), key)
	}
	return script.String()
}

// tmuxConfigQuote encodes every byte as a three-digit octal escape inside a
// double-quoted tmux configuration string. This handles quotes, dollars,
// backslashes, newlines, and UTF-8 without permitting configuration injection.
func tmuxConfigQuote(value string) string {
	var quoted strings.Builder
	quoted.Grow(2 + len(value)*4)
	quoted.WriteByte('"')
	for _, b := range []byte(value) {
		fmt.Fprintf(&quoted, "\\%03o", b)
	}
	quoted.WriteByte('"')
	return quoted.String()
}
