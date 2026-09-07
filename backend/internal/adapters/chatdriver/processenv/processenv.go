// Package processenv builds child-process environments shared by Chat drivers.
package processenv

import (
	"os"
	"runtime"
	"sort"
	"strings"
)

// Merge overlays session-specific values on the daemon environment and returns
// the KEY=VALUE form expected by os/exec. Sorting makes launches deterministic
// enough to inspect and compare in tests and process diagnostics.
func Merge(overlay map[string]string) []string {
	merged := make(map[string]string, len(os.Environ())+len(overlay))
	for _, entry := range os.Environ() {
		if key, _, ok := strings.Cut(entry, "="); ok {
			if runtime.GOOS == "windows" {
				key = strings.ToUpper(key)
			}
			merged[key] = entry
		}
	}
	for key, value := range overlay {
		entry := key + "=" + value
		if runtime.GOOS == "windows" {
			key = strings.ToUpper(key)
		}
		merged[key] = entry
	}

	out := make([]string, 0, len(merged))
	for _, entry := range merged {
		out = append(out, entry)
	}
	sort.Strings(out)
	return out
}
