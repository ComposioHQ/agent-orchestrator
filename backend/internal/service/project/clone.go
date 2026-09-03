package project

import (
	"context"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

var scpStyleGitURL = regexp.MustCompile(`^[^/@:\s]+@[^/:\s]+:(.+)$`)

var allowedCloneSchemes = map[string]struct{}{
	"file":  {},
	"git":   {},
	"http":  {},
	"https": {},
	"ssh":   {},
}

// Clone checks out one remote repository into a user-selected parent folder,
// then registers it through the same Add boundary as an existing local repo.
// The checkout is staged in a unique sibling directory so a failed or cancelled
// clone can never leave a half-populated destination behind.
func (m *Service) Clone(ctx context.Context, in CloneInput) (Project, error) {
	remoteURL := strings.TrimSpace(in.RemoteURL)
	repositoryName, err := cloneRepositoryName(remoteURL)
	if err != nil {
		return Project{}, err
	}
	parent, err := m.resolveCloneDestinationParent(in.DestinationParent)
	if err != nil {
		return Project{}, err
	}
	if in.Config != nil {
		if err := in.Config.Validate(); err != nil {
			return Project{}, apierr.Invalid("INVALID_PROJECT_CONFIG", err.Error(), nil)
		}
	}
	if in.ProjectID != nil {
		if err := validateProjectID(domain.ProjectID(strings.TrimSpace(*in.ProjectID))); err != nil {
			return Project{}, err
		}
	}

	target := filepath.Join(parent, repositoryName)
	if err := validateCloneTargetPathSafety(target, m.cloneDestinationParent); err != nil {
		return Project{}, err
	}
	if _, err := os.Lstat(target); err == nil {
		return Project{}, apierr.Conflict("CLONE_DESTINATION_EXISTS", "A folder with this repository name already exists in the selected destination.", map[string]any{"path": target})
	} else if !errors.Is(err, os.ErrNotExist) {
		return Project{}, apierr.Invalid("CLONE_DESTINATION_UNAVAILABLE", "The clone destination could not be inspected.", map[string]any{"path": target})
	}

	temporaryPath, err := os.MkdirTemp(parent, ".ao-clone-")
	if err != nil {
		return Project{}, apierr.Invalid("CLONE_DESTINATION_UNAVAILABLE", "AO could not prepare the selected clone destination.", nil)
	}
	cleanupPath := temporaryPath
	defer func() {
		if cleanupPath != "" {
			_ = os.RemoveAll(cleanupPath)
		}
	}()

	cmd := aoprocess.CommandContext(ctx, "git", "clone", "--origin", "origin", "--", remoteURL, temporaryPath)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=Never")
	if err := cmd.Run(); err != nil {
		var executableError *exec.Error
		if errors.As(err, &executableError) {
			return Project{}, apierr.Invalid("GIT_NOT_FOUND", "Git is required to clone a repository.", nil)
		}
		if ctx.Err() != nil {
			return Project{}, apierr.Invalid("GIT_CLONE_CANCELLED", "Repository cloning was cancelled.", nil)
		}
		return Project{}, apierr.Invalid("GIT_CLONE_FAILED", "Could not clone this repository. Check the URL, your Git credentials, and your network connection.", nil)
	}
	if !repoHasCommit(ctx, temporaryPath) {
		return Project{}, apierr.Invalid("CLONE_EMPTY_REPOSITORY", "AO needs a repository with at least one commit.", nil)
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return Project{}, apierr.Conflict("CLONE_DESTINATION_EXISTS", "The clone destination became unavailable before the repository could be created.", map[string]any{"path": target})
	}
	cleanupPath = target

	project, err := m.Add(ctx, AddInput{
		Path:      target,
		ProjectID: in.ProjectID,
		Name:      in.Name,
		Config:    in.Config,
	})
	if err != nil {
		return Project{}, err
	}
	cleanupPath = ""
	return project, nil
}

// DefaultCloneDestinationParent keeps cloned repositories beside AO's durable
// data directory: the normal ~/.ao/data therefore resolves to ~/.ao/repos, and
// an AO_DATA_DIR override carries its own sibling repos directory.
func DefaultCloneDestinationParent(dataDir string) string {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(filepath.Clean(dataDir)), "repos")
}

// PreflightClone performs a fresh filesystem observation for the exact target
// Clone will use. It is advisory only: Clone repeats the same Lstat immediately
// before starting Git so a target created after this call is still rejected.
func (m *Service) PreflightClone(ctx context.Context, in ClonePreflightInput) (ClonePreflightResult, error) {
	if err := ctx.Err(); err != nil {
		return ClonePreflightResult{}, clonePreflightCancelled()
	}
	parent, err := m.resolveCloneDestinationParent(in.DestinationParent)
	if err != nil {
		return ClonePreflightResult{}, err
	}
	result := ClonePreflightResult{DestinationParent: parent, Available: true}
	if strings.TrimSpace(in.RemoteURL) == "" {
		return result, nil
	}
	repositoryName, err := cloneRepositoryName(strings.TrimSpace(in.RemoteURL))
	if err != nil {
		return ClonePreflightResult{}, err
	}
	target := filepath.Join(parent, repositoryName)
	if err := validateCloneTargetPathSafety(target, m.cloneDestinationParent); err != nil {
		return ClonePreflightResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return ClonePreflightResult{}, clonePreflightCancelled()
	}
	result.TargetPath = target
	if _, err := os.Lstat(target); err == nil {
		result.Available = false
	} else if !errors.Is(err, os.ErrNotExist) {
		return ClonePreflightResult{}, apierr.Invalid("CLONE_DESTINATION_UNAVAILABLE", "The clone destination could not be inspected.", map[string]any{"path": target})
	}
	if err := ctx.Err(); err != nil {
		return ClonePreflightResult{}, clonePreflightCancelled()
	}
	return result, nil
}

func (m *Service) resolveCloneDestinationParent(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		raw = m.cloneDestinationParent
		if strings.TrimSpace(raw) == "" {
			return "", apierr.Invalid("CLONE_DESTINATION_REQUIRED", "Choose a destination folder.", nil)
		}
		if err := os.MkdirAll(raw, 0o750); err != nil {
			return "", apierr.Invalid("CLONE_DESTINATION_UNAVAILABLE", "AO could not prepare the default clone destination.", map[string]any{"path": raw})
		}
	}
	parent, err := normalizePath(raw)
	if err != nil {
		return "", err
	}
	if err := ensureDirectoryPath(parent); err != nil {
		return "", err
	}
	return parent, nil
}

func clonePreflightCancelled() error {
	return apierr.Invalid("CLONE_PREFLIGHT_CANCELLED", "Clone destination validation was cancelled.", nil)
}

func cloneRepositoryName(raw string) (string, error) {
	if raw == "" || strings.ContainsAny(raw, "\r\n\t ") || strings.HasPrefix(raw, "-") {
		return "", invalidCloneURL()
	}

	var remotePath string
	if match := scpStyleGitURL.FindStringSubmatch(raw); len(match) == 2 {
		remotePath = match[1]
	} else {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme == "" {
			return "", invalidCloneURL()
		}
		if _, ok := allowedCloneSchemes[strings.ToLower(parsed.Scheme)]; !ok {
			return "", invalidCloneURL()
		}
		scheme := strings.ToLower(parsed.Scheme)
		hasPassword := false
		if parsed.User != nil {
			_, hasPassword = parsed.User.Password()
		}
		if ((scheme == "http" || scheme == "https") && (parsed.User != nil || parsed.RawQuery != "")) || hasPassword {
			return "", apierr.Invalid("GIT_URL_CONTAINS_CREDENTIALS", "Use your configured Git credentials or an SSH URL instead of putting credentials in the repository URL.", nil)
		}
		remotePath = parsed.Path
	}

	remotePath = strings.TrimRight(remotePath, "/\\")
	name := strings.TrimSuffix(filepath.Base(remotePath), ".git")
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\\<>:"|?*`) {
		return "", invalidCloneURL()
	}
	return name, nil
}

func invalidCloneURL() error {
	return apierr.Invalid("INVALID_GIT_URL", "Enter a valid HTTPS, SSH, Git, or file repository URL.", nil)
}
