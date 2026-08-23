package sandboxruntime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/workspacewatch"
)

const (
	maxWorkspaceChanges   = 500
	maxWorkspaceCommits   = 50
	maxWorkspaceEntries   = 5000
	maxWorkspaceReadBytes = 8 << 20
)

// WorkspaceObserver implements the sole ports.WorkspaceObservation contract
// against one confined sandbox workspace.
type WorkspaceObserver struct {
	Root string
}

var _ ports.WorkspaceObservation = (*WorkspaceObserver)(nil)

// Snapshot returns bounded Git facts for the configured workspace.
func (o *WorkspaceObserver) Snapshot(ctx context.Context, info ports.WorkspaceInfo) (ports.WorkspaceSnapshot, error) {
	root, err := o.workspaceRoot(info)
	if err != nil {
		return ports.WorkspaceSnapshot{}, err
	}
	branch, err := gitOutput(ctx, root, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		branch = ""
	}
	head, err := gitOutput(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return ports.WorkspaceSnapshot{}, fmt.Errorf("observe workspace HEAD: %w", err)
	}
	status, err := gitOutputBytes(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return ports.WorkspaceSnapshot{}, fmt.Errorf("observe workspace status: %w", err)
	}
	changes, staged, untracked := parseStatus(status)
	log, err := gitOutputBytes(ctx, root, "log", "-n", fmt.Sprint(maxWorkspaceCommits), "--format=%H%x00%s%x00%aI%x00")
	if err != nil {
		return ports.WorkspaceSnapshot{}, fmt.Errorf("observe workspace log: %w", err)
	}
	return ports.WorkspaceSnapshot{
		Path: root, Branch: strings.TrimSpace(branch), HeadSHA: strings.TrimSpace(head),
		Dirty: len(changes) > 0, Staged: staged, Untracked: untracked,
		Changes: changes, Commits: parseCommits(log),
	}, nil
}

// List returns a bounded recursive listing without following symlinked trees.
func (o *WorkspaceObserver) List(ctx context.Context, request ports.WorkspaceListRequest) (ports.WorkspaceListResult, error) {
	if len(request.Workspaces) == 0 {
		return ports.WorkspaceListResult{}, errors.New("workspace list requires a workspace")
	}
	limit := request.MaxEntries
	if limit <= 0 || limit > maxWorkspaceEntries {
		limit = maxWorkspaceEntries
	}
	result := ports.WorkspaceListResult{Entries: make([]ports.WorkspaceEntry, 0)}
	for _, workspace := range request.Workspaces {
		root, err := o.workspaceRoot(workspace)
		if err != nil {
			return ports.WorkspaceListResult{}, err
		}
		err = filepath.WalkDir(root, func(fullPath string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if fullPath == root {
				return nil
			}
			if entry.IsDir() && entry.Name() == ".git" {
				return filepath.SkipDir
			}
			if len(result.Entries) >= limit {
				result.Truncated = true
				return fs.SkipAll
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(root, fullPath)
			if err != nil {
				return err
			}
			result.Entries = append(result.Entries, ports.WorkspaceEntry{
				WorkspacePath: root, Path: filepath.ToSlash(rel), Size: info.Size(),
				Mode: uint32(info.Mode()), ModTime: info.ModTime(), Directory: entry.IsDir(),
			})
			return nil
		})
		if err != nil {
			return ports.WorkspaceListResult{}, err
		}
		if result.Truncated {
			break
		}
	}
	return result, nil
}

// Read returns one bounded, confined workspace file.
func (o *WorkspaceObserver) Read(_ context.Context, request ports.WorkspaceReadRequest) (ports.WorkspaceReadResult, error) {
	root, err := o.workspaceRoot(request.Workspace)
	if err != nil {
		return ports.WorkspaceReadResult{}, err
	}
	path, rel, err := confinedPath(root, request.Path)
	if err != nil {
		return ports.WorkspaceReadResult{}, err
	}
	data, size, modTime, truncated, err := readBounded(path, request.MaxBytes)
	if err != nil {
		return ports.WorkspaceReadResult{}, err
	}
	return ports.WorkspaceReadResult{
		Path: filepath.ToSlash(rel), Data: data, Size: size, ModTime: modTime,
		MediaType: mime.TypeByExtension(filepath.Ext(rel)), Truncated: truncated,
	}, nil
}

// Watch emits coalesced invalidations for the configured workspace.
func (o *WorkspaceObserver) Watch(ctx context.Context, request ports.WorkspaceWatchRequest) (<-chan ports.WorkspaceEvent, error) {
	if len(request.Workspaces) == 0 {
		return nil, errors.New("workspace watch requires a workspace")
	}
	roots := make([]string, 0, len(request.Workspaces))
	for _, workspace := range request.Workspaces {
		root, err := o.workspaceRoot(workspace)
		if err != nil {
			return nil, err
		}
		roots = append(roots, root)
	}
	source, err := workspacewatch.Watch(ctx, roots...)
	if err != nil {
		return nil, err
	}
	events := make(chan ports.WorkspaceEvent, 1)
	go func() {
		defer close(events)
		for range source {
			select {
			case events <- ports.WorkspaceEvent{}:
			default:
			}
		}
	}()
	return events, nil
}

// Diff returns a bounded unified Git diff for the configured workspace.
func (o *WorkspaceObserver) Diff(ctx context.Context, request ports.WorkspaceDiffRequest) (ports.WorkspaceDiffResult, error) {
	root, err := o.workspaceRoot(request.Workspace)
	if err != nil {
		return ports.WorkspaceDiffResult{}, err
	}
	args := []string{"diff", "--no-ext-diff", "--binary"}
	if strings.TrimSpace(request.Base) != "" {
		base, err := safeRevision(request.Base)
		if err != nil {
			return ports.WorkspaceDiffResult{}, err
		}
		args = append(args, "--end-of-options", base)
	}
	if request.Path != "" {
		rel, err := safeRelPath(request.Path)
		if err != nil {
			return ports.WorkspaceDiffResult{}, err
		}
		args = append(args, "--", filepath.ToSlash(rel))
	}
	out, err := gitOutputBytes(ctx, root, args...)
	if err != nil {
		return ports.WorkspaceDiffResult{}, err
	}
	out, truncated := bounded(out, request.MaxBytes)
	return ports.WorkspaceDiffResult{UnifiedDiff: string(out), Truncated: truncated}, nil
}

// Blob reads a bounded worktree file or historical Git blob.
func (o *WorkspaceObserver) Blob(ctx context.Context, request ports.WorkspaceBlobRequest) (ports.WorkspaceBlobResult, error) {
	root, err := o.workspaceRoot(request.Workspace)
	if err != nil {
		return ports.WorkspaceBlobResult{}, err
	}
	rel, err := safeRelPath(request.Path)
	if err != nil {
		return ports.WorkspaceBlobResult{}, err
	}
	var data []byte
	var truncated bool
	if strings.TrimSpace(request.Revision) == "" {
		var path string
		path, _, err = confinedPath(root, rel)
		if err != nil {
			return ports.WorkspaceBlobResult{}, err
		}
		data, _, _, truncated, err = readBounded(path, request.MaxBytes)
	} else {
		revision, revisionErr := safeRevision(request.Revision)
		if revisionErr != nil {
			return ports.WorkspaceBlobResult{}, revisionErr
		}
		data, err = gitOutputBytes(ctx, root, "show", "--end-of-options", revision+":"+filepath.ToSlash(rel))
		data, truncated = bounded(data, request.MaxBytes)
	}
	if err != nil {
		return ports.WorkspaceBlobResult{}, err
	}
	return ports.WorkspaceBlobResult{
		Path: filepath.ToSlash(rel), Data: data,
		MediaType: mime.TypeByExtension(filepath.Ext(rel)), Truncated: truncated,
	}, nil
}

func (o *WorkspaceObserver) workspaceRoot(info ports.WorkspaceInfo) (string, error) {
	if o == nil || o.Root == "" || !filepath.IsAbs(o.Root) {
		return "", errors.New("sandbox workspace root is not configured")
	}
	root := filepath.Clean(o.Root)
	if info.Path != "" && filepath.Clean(info.Path) != root {
		return "", errors.New("workspace is outside sandbox scope")
	}
	return root, nil
}

func confinedPath(root, raw string) (string, string, error) {
	rel, err := safeRelPath(raw)
	if err != nil {
		return "", "", err
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", err
	}
	joined := filepath.Join(rootReal, rel)
	resolved, err := filepath.EvalSymlinks(joined)
	if err != nil {
		return "", "", err
	}
	within, err := filepath.Rel(rootReal, resolved)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) {
		return "", "", errors.New("workspace path resolves outside root")
	}
	return resolved, rel, nil
}

func safeRelPath(raw string) (string, error) {
	if raw == "" || filepath.IsAbs(raw) {
		return "", errors.New("workspace path must be relative")
	}
	rel := filepath.Clean(filepath.FromSlash(raw))
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("workspace path escapes root")
	}
	return rel, nil
}

func safeRevision(raw string) (string, error) {
	revision := strings.TrimSpace(raw)
	if revision == "" || strings.HasPrefix(revision, "-") || strings.ContainsAny(revision, "\x00\r\n") {
		return "", errors.New("workspace revision is invalid")
	}
	return revision, nil
}

func readBounded(path string, requested int64) ([]byte, int64, time.Time, bool, error) {
	limit := requested
	if limit <= 0 || limit > maxWorkspaceReadBytes {
		limit = maxWorkspaceReadBytes
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, 0, time.Time{}, false, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, 0, time.Time{}, false, err
	}
	if !info.Mode().IsRegular() {
		return nil, 0, time.Time{}, false, errors.New("workspace read target is not a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, 0, time.Time{}, false, err
	}
	truncated := int64(len(data)) > limit
	if truncated {
		data = data[:limit]
	}
	return data, info.Size(), info.ModTime(), truncated, nil
}

func bounded(data []byte, requested int64) ([]byte, bool) {
	limit := requested
	if limit <= 0 || limit > maxWorkspaceReadBytes {
		limit = maxWorkspaceReadBytes
	}
	if int64(len(data)) <= limit {
		return data, false
	}
	return data[:limit], true
}

func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := gitOutputBytes(ctx, dir, args...)
	return string(out), err
}

func gitOutputBytes(ctx context.Context, dir string, args ...string) ([]byte, error) {
	// #nosec G702 -- arguments are passed directly without a shell; every
	// workspace path is confined and pathspecs follow an explicit -- separator.
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/nonexistent", "GIT_CONFIG_NOSYSTEM=1"}
	return cmd.Output()
}

func parseStatus(raw []byte) ([]ports.WorkspaceChange, bool, bool) {
	parts := bytes.Split(raw, []byte{0})
	changes := make([]ports.WorkspaceChange, 0, min(len(parts), maxWorkspaceChanges))
	var staged, untracked bool
	for i := 0; i < len(parts) && len(changes) < maxWorkspaceChanges; i++ {
		entry := string(parts[i])
		if len(entry) < 4 {
			continue
		}
		status, path := entry[:2], entry[3:]
		if status[0] != ' ' && status[0] != '?' {
			staged = true
		}
		if status == "??" {
			untracked = true
		}
		if (status[0] == 'R' || status[0] == 'C') && i+1 < len(parts) {
			i++
			path = string(parts[i])
		}
		changes = append(changes, ports.WorkspaceChange{Path: path, Status: status})
	}
	return changes, staged, untracked
}

func parseCommits(raw []byte) []ports.WorkspaceCommit {
	parts := bytes.Split(raw, []byte{0})
	commits := make([]ports.WorkspaceCommit, 0, min(len(parts)/3, maxWorkspaceCommits))
	for i := 0; i+2 < len(parts) && len(commits) < maxWorkspaceCommits; i += 3 {
		sha := strings.TrimSpace(string(parts[i]))
		if sha == "" {
			break
		}
		authored := strings.TrimSpace(string(parts[i+2]))
		if _, err := time.Parse(time.RFC3339, authored); err != nil {
			authored = ""
		}
		commits = append(commits, ports.WorkspaceCommit{SHA: sha, Subject: string(parts[i+1]), AuthoredAt: authored})
	}
	return commits
}
