package session

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	delegatedTaskTitleLimit             = 20
	delegatedTaskUntitledName           = "Untitled task"
	delegatedTaskTitleRefinementTimeout = time.Minute
)

// DelegateTaskInput describes a task AO should spawn as a worker session. Brief
// may be empty to open an idle worker that the user can instruct later. Empty
// RequestedAgent means the spawn uses the project's worker-agent default.
type DelegateTaskInput struct {
	ProjectID      domain.ProjectID
	Brief          string
	RequestedAgent domain.AgentHarness
	Model          string
	ApprovalMode   domain.PermissionMode
	RequestedMode  domain.SessionMode
	Attachments    []ports.SpawnAttachment
}

// DelegateTaskOutcome identifies the spawned worker. OrchestratorID remains
// optional for wire compatibility; asynchronous title refinement does not wait
// to resolve the coordinator before returning.
type DelegateTaskOutcome struct {
	OrchestratorID domain.SessionID
	WorkerID       domain.SessionID
}

// DelegateTask spawns the worker directly, matching `ao spawn`, with a
// provisional display name derived from the task brief. AO then best-effort
// asks the worker to refine its own title.
func (s *Service) DelegateTask(ctx context.Context, in DelegateTaskInput) (DelegateTaskOutcome, error) {
	if _, err := s.requireProject(ctx, in.ProjectID); err != nil {
		return DelegateTaskOutcome{}, err
	}
	if in.RequestedAgent != "" && !in.RequestedAgent.IsKnown() {
		return DelegateTaskOutcome{}, apierr.Invalid("UNKNOWN_HARNESS", "Unknown requested agent", nil)
	}
	if in.RequestedMode != "" && !in.RequestedMode.Valid() {
		return DelegateTaskOutcome{}, apierr.Invalid("INVALID_SESSION_MODE", "mode must be chat or tui", nil)
	}
	prompt := in.Brief
	if strings.TrimSpace(prompt) == "" {
		prompt = ""
	}

	worker, _, _, err := s.manager.Spawn(ctx, ports.SpawnConfig{
		ProjectID:   in.ProjectID,
		Kind:        domain.KindWorker,
		Harness:     in.RequestedAgent,
		Prompt:      prompt,
		DisplayName: delegatedTaskDisplayName(in.Brief),
		AgentConfig: ports.AgentConfig{
			Model:       strings.TrimSpace(in.Model),
			Permissions: in.ApprovalMode,
		},
		RequestedMode: in.RequestedMode,
		Attachments:   in.Attachments,
	})
	if err != nil {
		return DelegateTaskOutcome{}, toSpawnAPIError(err)
	}

	// The worker spawn is the commit point. Coordinator startup and title
	// generation must never hold the new-task response open. A promptless worker
	// stays idle with its provisional title until the user supplies instructions.
	if prompt != "" {
		s.refineDelegatedTaskTitleInBackground(worker.ID, in)
	}
	return DelegateTaskOutcome{WorkerID: worker.ID}, nil
}

func (s *Service) refineDelegatedTaskTitleInBackground(workerID domain.SessionID, in DelegateTaskInput) {
	work := func() {
		base := s.backgroundContext
		if base == nil {
			base = context.Background()
		}
		ctx, cancel := context.WithTimeout(base, delegatedTaskTitleRefinementTimeout)
		defer cancel()

		if err := s.refineDelegatedTaskTitle(ctx, workerID, in); err != nil && s.logger != nil {
			s.logger.Warn("delegated task title refinement failed",
				"projectID", in.ProjectID,
				"workerID", workerID,
				"error", err,
			)
		}
	}
	if s.runBackground != nil {
		s.runBackground(work)
		return
	}
	go work()
}

func (s *Service) refineDelegatedTaskTitle(ctx context.Context, workerID domain.SessionID, in DelegateTaskInput) error {
	if err := s.manager.WaitForMessageDeliveryReady(ctx, workerID); err != nil {
		return fmt.Errorf("wait for title worker %s: %w", workerID, err)
	}
	if err := s.manager.Send(ctx, workerID, taskTitleDelegationMessage(workerID, in), nil); err != nil {
		return fmt.Errorf("send title request to worker %s: %w", workerID, err)
	}
	return nil
}

func delegatedTaskDisplayName(brief string) string {
	title := strings.Join(strings.Fields(brief), " ")
	if title == "" {
		return delegatedTaskUntitledName
	}
	if utf8.RuneCountInString(title) <= delegatedTaskTitleLimit {
		return title
	}
	return strings.TrimSpace(string([]rune(title)[:delegatedTaskTitleLimit]))
}

func taskTitleDelegationMessage(workerID domain.SessionID, in DelegateTaskInput) string {
	var b strings.Builder
	b.WriteString("AO TASK TITLE UPDATE\n")
	b.WriteString("You are the worker that was just spawned for this task. Do not spawn another worker or orchestrator. Choose a concise title from the brief and rename this session.\n")
	b.WriteString("Choose a concise task title from the brief and run:\n\n")
	b.WriteString("ao session rename ")
	b.WriteString(string(workerID))
	b.WriteString(" \"<title, max 20 chars>\"\n\n")
	b.WriteString("Worker session id: ")
	b.WriteString(string(workerID))
	b.WriteString("\nTask brief:\n")
	b.WriteString(in.Brief)
	if model := strings.TrimSpace(in.Model); model != "" {
		b.WriteString("\nRequested model: ")
		b.WriteString(model)
	}
	return b.String()
}
