package androidemulator

import (
	"bufio"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// SourceMatch is one candidate source line that might define or reference
// the UI element identified by a given resource-id, testID, or visible text.
type SourceMatch struct {
	Path string
	Line int
	Text string
}

// maxSourceMatches bounds the result set so a very common identifier (e.g. a
// generic name reused across a large tree) can't produce an unbounded scan
// result.
const maxSourceMatches = 50

// searchExtensions bounds which files get scanned: source files likely to
// define UI elements across native Android and React Native, not every file
// in the tree.
var searchExtensions = map[string]bool{
	".xml": true, ".kt": true, ".java": true,
	".js": true, ".jsx": true, ".ts": true, ".tsx": true,
	".dart": true,
}

// excludedDirs are skipped entirely: vendored/generated/VCS trees that would
// only add noise or make the search prohibitively slow.
var excludedDirs = map[string]bool{
	".git": true, "node_modules": true, "build": true, ".gradle": true,
	"dist": true, ".dart_tool": true,
}

// FindSource searches worktreeRoot for files referencing identifier (a
// resource-id like "android:id/aerr_close" or "com.myapp:id/my_button", a
// testID, or visible text), returning candidate source files.
//
// This is a heuristic, best-effort match: a plain substring search for the
// identifier's short name across common UI source file types, not a
// guaranteed-exact symbolication. It deliberately doesn't special-case
// per-framework syntax (android:id="..." vs testID="..." vs testID={...}) --
// the short identifier string appears literally in all of them, so one
// simple search covers every case without fragile framework-specific
// regexes. Exact symbolication (Metro source maps, Flutter DevTools) is
// explicitly out of scope, matching the framework-agnostic decision.
func FindSource(ctx context.Context, worktreeRoot, identifier string) ([]SourceMatch, error) {
	needle := shortIdentifier(identifier)
	if needle == "" {
		return nil, nil
	}

	var matches []SourceMatch
	err := filepath.WalkDir(worktreeRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry; skip rather than abort the whole search
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if len(matches) >= maxSourceMatches {
			return filepath.SkipAll
		}
		if d.IsDir() {
			if excludedDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !searchExtensions[filepath.Ext(path)] {
			return nil
		}
		fileMatches, err := searchFile(path, needle)
		if err != nil {
			return nil // unreadable file; skip
		}
		matches = append(matches, fileMatches...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(matches) > maxSourceMatches {
		matches = matches[:maxSourceMatches]
	}
	return matches, nil
}

// shortIdentifier extracts the searchable id from a resource-id like
// "android:id/aerr_close" or "com.myapp:id/my_button" -> "aerr_close" /
// "my_button". Source code never spells out the full "pkg:id/name" form,
// only the short name.
func shortIdentifier(identifier string) string {
	if idx := strings.LastIndex(identifier, "/"); idx >= 0 {
		return identifier[idx+1:]
	}
	return identifier
}

func searchFile(path, needle string) ([]SourceMatch, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var matches []SourceMatch
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := scanner.Text()
		if strings.Contains(line, needle) {
			matches = append(matches, SourceMatch{Path: path, Line: lineNum, Text: strings.TrimSpace(line)})
		}
	}
	return matches, nil
}
