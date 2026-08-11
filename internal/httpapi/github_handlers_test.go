package httpapi

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
)

func TestGitHubWireResponsesPreserveIntegerPrecision(t *testing.T) {
	const largeID int64 = 1786467382635984000
	installation := toGitHubInstallationResponse(domain.GitHubInstallation{
		GitHubInstallationID: largeID,
	})
	repository := toGitHubRepositoryResponse(domain.GitHubRepository{
		GitHubRepositoryID: largeID,
	})
	if installation.GitHubInstallationID != strconv.FormatInt(largeID, 10) {
		t.Fatalf("installation ID = %q", installation.GitHubInstallationID)
	}
	if repository.GitHubRepositoryID != strconv.FormatInt(largeID, 10) {
		t.Fatalf("repository ID = %q", repository.GitHubRepositoryID)
	}
	encoded, err := json.Marshal(map[string]any{
		"installation": installation,
		"repository":   repository,
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Installation struct {
			GitHubInstallationID string `json:"githubInstallationId"`
		} `json:"installation"`
		Repository struct {
			GitHubRepositoryID string `json:"githubRepositoryId"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Installation.GitHubInstallationID != strconv.FormatInt(largeID, 10) ||
		decoded.Repository.GitHubRepositoryID != strconv.FormatInt(largeID, 10) {
		t.Fatalf("decoded GitHub IDs lost precision: %s", encoded)
	}
}

func TestGitHubRepositoryResponseMarksRevokedAccess(t *testing.T) {
	revokedAt := time.Now()
	response := toGitHubRepositoryResponse(domain.GitHubRepository{
		GitHubRepositoryID: 42,
		RevokedAt:          &revokedAt,
	})
	if response.Access != "revoked" || response.RevokedAt != &revokedAt {
		t.Fatalf("repository response = %#v", response)
	}
}
