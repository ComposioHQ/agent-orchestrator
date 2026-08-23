package sandboxruntime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	maxWorkspaceChanges = 500
	maxWorkspaceCommits = 50
)

// WorkspaceObserver implements the same single WorkspaceObserver port consumed
// by session management, using only bounded local git commands.
type WorkspaceObserver struct{}

// ObserveWorkspace returns the bounded provider-neutral workspace snapshot.
func (WorkspaceObserver) ObserveWorkspace(ctx context.Context, info ports.WorkspaceInfo) (ports.WorkspaceObservation, error) {
	if info.Path == "" {
		return ports.WorkspaceObservation{}, errors.New("workspace observation path is required")
	}
	branch, err := gitOutput(ctx, info.Path, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		branch = ""
	}
	head, err := gitOutput(ctx, info.Path, "rev-parse", "HEAD")
	if err != nil {
		return ports.WorkspaceObservation{}, fmt.Errorf("observe workspace HEAD: %w", err)
	}
	status, err := gitOutputBytes(ctx, info.Path, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return ports.WorkspaceObservation{}, fmt.Errorf("observe workspace status: %w", err)
	}
	changes, staged, untracked := parseStatus(status)
	log, err := gitOutputBytes(ctx, info.Path, "log", "-n", fmt.Sprint(maxWorkspaceCommits), "--format=%H%x00%s%x00%aI%x00")
	if err != nil {
		return ports.WorkspaceObservation{}, fmt.Errorf("observe workspace log: %w", err)
	}
	return ports.WorkspaceObservation{
		Path: info.Path, Branch: strings.TrimSpace(branch), HeadSHA: strings.TrimSpace(head),
		Dirty: len(changes) > 0, Staged: staged, Untracked: untracked,
		Changes: changes, Commits: parseCommits(log),
	}, nil
}

func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := gitOutputBytes(ctx, dir, args...)
	return string(out), err
}

func gitOutputBytes(ctx context.Context, dir string, args ...string) ([]byte, error) {
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
		// Porcelain -z represents rename/copy destinations in the next item.
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
