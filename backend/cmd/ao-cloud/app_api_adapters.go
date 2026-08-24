package main

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

// hostedAppStore is the durable portion of the shared application API. The
// production implementation is PostgreSQL and reads tenant identity only from
// context; keeping this as ports also makes composition tests independent of a
// database process.
type hostedAppStore interface {
	ports.ProjectStore
	ports.SessionStore
	ports.SessionWorktreeStore
}

type hostedProjectManager struct {
	store ports.ProjectStore
}

var _ projectsvc.Manager = (*hostedProjectManager)(nil)

func newHostedProjectManager(store ports.ProjectStore) *hostedProjectManager {
	return &hostedProjectManager{store: store}
}

func (m *hostedProjectManager) List(ctx context.Context) ([]projectsvc.Summary, error) {
	records, err := m.store.ListProjects(ctx)
	if err != nil {
		return nil, apierr.Internal("PROJECTS_LIST_FAILED", "Failed to load projects")
	}
	out := make([]projectsvc.Summary, 0, len(records))
	for _, record := range records {
		out = append(out, projectsvc.Summary{
			ID:                domain.ProjectID(record.ID),
			Name:              hostedProjectName(record),
			Path:              record.Path,
			Kind:              record.Kind.WithDefault(),
			SessionPrefix:     hostedSessionPrefix(record),
			OrchestratorAgent: record.Config.Orchestrator.Harness,
		})
	}
	return out, nil
}

func (m *hostedProjectManager) Get(ctx context.Context, id domain.ProjectID) (projectsvc.GetResult, error) {
	record, ok, err := m.store.GetProject(ctx, string(id))
	if err != nil {
		return projectsvc.GetResult{}, apierr.Internal("PROJECT_LOAD_FAILED", "Failed to load project")
	}
	if !ok || !record.ArchivedAt.IsZero() {
		return projectsvc.GetResult{}, apierr.NotFound("PROJECT_NOT_FOUND", "Unknown project")
	}
	defaultBranch := ""
	if record.Kind.WithDefault() != domain.ProjectKindScratch {
		defaultBranch = strings.TrimSpace(record.Config.WorktreeBaseBranch())
		if defaultBranch == "" {
			return projectsvc.GetResult{Status: "degraded", Degraded: &projectsvc.Degraded{
				ID: recordProjectID(record), Name: hostedProjectName(record), Kind: record.Kind.WithDefault(), Path: record.Path,
				ResolveError: "default branch is unavailable in hosted project metadata",
			}}, nil
		}
	}
	project := projectsvc.Project{
		ID: recordProjectID(record), Name: hostedProjectName(record), Kind: record.Kind.WithDefault(),
		Path: record.Path, Repo: record.RepoOriginURL, DefaultBranch: defaultBranch,
	}
	if !record.Config.IsZero() {
		config := record.Config
		project.Config = &config
	}
	if record.Kind.WithDefault() == domain.ProjectKindWorkspace {
		repos, listErr := m.store.ListWorkspaceRepos(ctx, record.ID)
		if listErr != nil {
			return projectsvc.GetResult{}, apierr.Internal("PROJECT_LOAD_FAILED", "Failed to load workspace repositories")
		}
		project.WorkspaceRepos = make([]projectsvc.WorkspaceRepo, 0, len(repos))
		for _, repo := range repos {
			project.WorkspaceRepos = append(project.WorkspaceRepos, projectsvc.WorkspaceRepo{Name: repo.Name, RelativePath: repo.RelativePath, Repo: repo.RepoOriginURL})
		}
	}
	return projectsvc.GetResult{Status: "ok", Project: &project}, nil
}

func (m *hostedProjectManager) Add(context.Context, projectsvc.AddInput) (projectsvc.Project, error) {
	return projectsvc.Project{}, hostedProjectPlacementRequired()
}

func (m *hostedProjectManager) Clone(context.Context, projectsvc.CloneInput) (projectsvc.Project, error) {
	return projectsvc.Project{}, hostedProjectPlacementRequired()
}

func (m *hostedProjectManager) InitializeRepository(context.Context, projectsvc.InitializeRepositoryInput) (projectsvc.InitializeRepositoryResult, error) {
	return projectsvc.InitializeRepositoryResult{}, hostedProjectPlacementRequired()
}

func (m *hostedProjectManager) UpdateSettings(context.Context, domain.ProjectID, projectsvc.UpdateSettingsInput) (projectsvc.Project, error) {
	return projectsvc.Project{}, hostedProjectPlacementRequired()
}

func (m *hostedProjectManager) SetConfig(context.Context, domain.ProjectID, projectsvc.SetConfigInput) (projectsvc.Project, error) {
	return projectsvc.Project{}, hostedProjectPlacementRequired()
}

func (m *hostedProjectManager) Remove(context.Context, domain.ProjectID) (projectsvc.RemoveResult, error) {
	return projectsvc.RemoveResult{}, hostedProjectPlacementRequired()
}

func hostedProjectPlacementRequired() error {
	return apierr.NotImplemented("HOSTED_PROJECT_PLACEMENT_REQUIRED", "Hosted project mutations require the workspace placement service")
}

func recordProjectID(record domain.ProjectRecord) domain.ProjectID {
	return domain.ProjectID(record.ID)
}

func hostedProjectName(record domain.ProjectRecord) string {
	if name := strings.TrimSpace(record.DisplayName); name != "" {
		return name
	}
	return record.ID
}

func hostedSessionPrefix(record domain.ProjectRecord) string {
	if prefix := strings.TrimSpace(record.Config.SessionPrefix); prefix != "" {
		return prefix
	}
	if len(record.ID) > 12 {
		return record.ID[:12]
	}
	return record.ID
}

// hostedSessionStore adds neutral SCM/switch observations to the core hosted
// store until their Postgres read adapters land. Core project/session/worktree
// reads remain tenant scoped by the embedded store.
type hostedSessionStore struct{ hostedAppStore }

func (hostedSessionStore) GetActiveAgentSwitch(context.Context, domain.SessionID) (domain.AgentSwitch, bool, error) {
	return domain.AgentSwitch{}, false, nil
}
func (hostedSessionStore) ListActiveAgentSwitches(context.Context) ([]domain.AgentSwitch, error) {
	return []domain.AgentSwitch{}, nil
}
func (hostedSessionStore) GetDisplayPRFactsForSession(context.Context, domain.SessionID) (domain.PRFacts, bool, error) {
	return domain.PRFacts{}, false, nil
}
func (hostedSessionStore) ListPRFactsForSession(context.Context, domain.SessionID) ([]domain.PRFacts, error) {
	return []domain.PRFacts{}, nil
}
func (hostedSessionStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	return []domain.PullRequest{}, nil
}
func (hostedSessionStore) ListChecks(context.Context, string) ([]domain.PullRequestCheck, error) {
	return []domain.PullRequestCheck{}, nil
}
func (hostedSessionStore) ListPRReviews(context.Context, string) ([]domain.PullRequestReview, error) {
	return []domain.PullRequestReview{}, nil
}
func (hostedSessionStore) ListPRReviewThreads(context.Context, string) ([]domain.PullRequestReviewThread, error) {
	return []domain.PullRequestReviewThread{}, nil
}
func (hostedSessionStore) ListPRComments(context.Context, string) ([]domain.PullRequestComment, error) {
	return []domain.PullRequestComment{}, nil
}

// unavailableHostedSessionCommands preserves the read side while making every
// compute-dependent command an explicit 501. This is replaced as one unit when
// the hosted SessionExecution and agent resolver are composed.
type unavailableHostedSessionCommands struct{}

func hostedExecutionUnavailable() error {
	return apierr.NotImplemented("HOSTED_SESSION_EXECUTION_UNAVAILABLE", "Hosted session execution is not configured")
}

func (*unavailableHostedSessionCommands) Spawn(context.Context, ports.SpawnConfig) (domain.SessionRecord, int, int, error) {
	return domain.SessionRecord{}, 0, 0, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) SwitchAgent(context.Context, domain.SessionID, sessionmanager.SwitchAgentConfig) (domain.AgentSwitch, error) {
	return domain.AgentSwitch{}, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) RecoverAgentSwitch(context.Context, domain.SessionID, domain.AgentSwitchID) (domain.AgentSwitch, error) {
	return domain.AgentSwitch{}, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) ListAgentSwitches(context.Context, domain.SessionID) ([]domain.AgentSwitch, error) {
	return nil, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) SubmitAgentHandoff(context.Context, domain.SessionID, domain.AgentSwitchID, domain.AgentGenerationID, json.RawMessage) (domain.AgentSwitch, error) {
	return domain.AgentSwitch{}, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) RestoreWithMode(context.Context, domain.SessionID) (sessionmanager.RestoreResult, error) {
	return sessionmanager.RestoreResult{}, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) ResumeAgentWithMode(context.Context, domain.SessionID) (sessionmanager.RestoreResult, error) {
	return sessionmanager.RestoreResult{}, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) Kill(context.Context, domain.SessionID) (bool, error) {
	return false, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) RetireForReplacement(context.Context, domain.SessionID) error {
	return hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) WaitForMessageDeliveryReady(context.Context, domain.SessionID) error {
	return hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) Send(context.Context, domain.SessionID, string, *ports.SpawnAttachment) error {
	return hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) Cleanup(context.Context, domain.ProjectID) (sessionmanager.CleanupResult, error) {
	return sessionmanager.CleanupResult{}, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) RollbackSpawn(context.Context, domain.SessionID) (bool, bool, error) {
	return false, false, hostedExecutionUnavailable()
}
func (*unavailableHostedSessionCommands) StageAttachments(context.Context, domain.SessionID, []ports.SpawnAttachment) ([]string, error) {
	return nil, hostedExecutionUnavailable()
}
