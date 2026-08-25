package session

import (
	"context"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// withCurrentWorkspaceBranch overlays mutable git state onto the API read
// model. Metadata.Branch remains the durable spawn-time fallback: branch
// changes can also be made directly by an agent, outside AO's command path, so
// treating that seed value as the live source of truth produces stale UI/API
// state.
func (s *Service) withCurrentWorkspaceBranch(ctx context.Context, rec domain.SessionRecord) domain.SessionRecord {
	if s.workspaceBranches == nil || rec.IsTerminated ||
		strings.TrimSpace(rec.Metadata.Branch) == "" ||
		strings.TrimSpace(rec.Metadata.WorkspacePath) == "" {
		return rec
	}
	branch, err := s.workspaceBranches.CurrentBranch(ctx, rec.Metadata.WorkspacePath)
	if err != nil {
		return rec
	}
	if branch = strings.TrimSpace(branch); branch != "" {
		rec.Metadata.Branch = branch
	}
	return rec
}
