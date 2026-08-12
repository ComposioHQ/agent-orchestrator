package githubapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/google/uuid"
)

type Store interface {
	CreateGitHubInstallAttempt(context.Context, domain.Principal, string, []byte, time.Time) (domain.GitHubInstallAttempt, error)
	ValidateGitHubInstallState(context.Context, []byte) error
	BeginGitHubOAuth(context.Context, []byte, domain.GitHubInstallation, []byte, []byte, []byte, time.Time) (domain.GitHubInstallAttempt, error)
	GitHubOAuthAttempt(context.Context, []byte) (domain.GitHubInstallAttempt, error)
	CompleteGitHubInstallation(context.Context, []byte, domain.GitHubInstallation) (domain.GitHubInstallation, error)
	ListGitHubInstallations(context.Context, domain.Principal, string) ([]domain.GitHubInstallation, error)
	GitHubInstallationForSync(context.Context, domain.Principal, string, string) (domain.GitHubInstallation, error)
	BeginGitHubRepositorySync(context.Context, domain.GitHubInstallation) (int64, error)
	ReconcileGitHubRepositories(context.Context, string, domain.GitHubInstallation, int64, []domain.GitHubRepository) error
	MarkGitHubSyncFailure(context.Context, string, domain.GitHubInstallation, int64, string) error
	DisconnectGitHubInstallation(context.Context, domain.Principal, string, string) (domain.GitHubInstallation, error)
	ListGitHubRepositories(context.Context, domain.Principal, string, *domain.Cursor, int) ([]domain.GitHubRepository, bool, error)
	InsertGitHubWebhook(context.Context, domain.GitHubWebhookDelivery, []byte) (bool, error)
	ClaimGitHubWebhook(context.Context, string, time.Time) (domain.GitHubWebhookDelivery, error)
	CompleteGitHubWebhook(context.Context, string, string) error
	RetryGitHubWebhook(context.Context, string, string, string, time.Time, bool) error
	GitHubInstallationRoute(context.Context, int64) (string, string, error)
	GitHubInstallationByRoute(context.Context, string, string) (domain.GitHubInstallation, error)
	ApplyGitHubInstallationEvent(context.Context, string, string, string) error
}

type Service struct {
	store         Store
	client        *Client
	stateKey      []byte
	webhookSecret string
	installTTL    time.Duration
	logger        *slog.Logger
	workerID      string
	checkMu       sync.Mutex
	checkAt       time.Time
	checkErr      error
}

func (s *Service) Check(ctx context.Context) error {
	s.checkMu.Lock()
	defer s.checkMu.Unlock()
	if !s.checkAt.IsZero() && time.Since(s.checkAt) < 30*time.Second {
		return s.checkErr
	}
	s.checkErr = s.client.Check(ctx)
	s.checkAt = time.Now()
	return s.checkErr
}

func NewService(
	store Store,
	client *Client,
	stateKey []byte,
	webhookSecret string,
	installTTL time.Duration,
	logger *slog.Logger,
) (*Service, error) {
	if store == nil || client == nil || len(stateKey) != 32 ||
		webhookSecret == "" || installTTL <= 0 {
		return nil, errors.New("GitHub App service configuration is incomplete")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		store:         store,
		client:        client,
		stateKey:      append([]byte(nil), stateKey...),
		webhookSecret: webhookSecret,
		installTTL:    installTTL,
		logger:        logger,
		workerID:      uuid.NewString(),
	}, nil
}

func (s *Service) StartInstallation(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
) (string, time.Time, error) {
	state, stateHash, err := NewState()
	if err != nil {
		return "", time.Time{}, err
	}
	expiresAt := time.Now().UTC().Add(s.installTTL)
	if _, err := s.store.CreateGitHubInstallAttempt(
		ctx,
		principal,
		orgID,
		stateHash,
		expiresAt,
	); err != nil {
		return "", time.Time{}, err
	}
	return s.client.InstallationURL(state), expiresAt, nil
}

func (s *Service) BeginOAuth(
	ctx context.Context,
	state string,
	installationID int64,
) (string, error) {
	if state == "" || installationID <= 0 {
		return "", postgres.ErrInvalid
	}
	installStateHash := HashState(state)
	if err := s.store.ValidateGitHubInstallState(ctx, installStateHash); err != nil {
		return "", err
	}
	providerInstallation, err := s.client.GetInstallation(ctx, installationID)
	if err != nil {
		return "", err
	}
	if !InstallationSupportsAuthorityProof(providerInstallation) {
		return "", postgres.ErrForbidden
	}
	oauthState, oauthStateHash, err := NewState()
	if err != nil {
		return "", err
	}
	verifier, challenge, err := NewPKCE()
	if err != nil {
		return "", err
	}
	associatedData := []byte(strconv.FormatInt(installationID, 10))
	ciphertext, nonce, err := Encrypt(
		s.stateKey,
		[]byte(verifier),
		associatedData,
	)
	if err != nil {
		return "", err
	}
	expiresAt := time.Now().UTC().Add(s.installTTL)
	_, err = s.store.BeginGitHubOAuth(
		ctx,
		installStateHash,
		toDomainInstallation(providerInstallation),
		oauthStateHash,
		ciphertext,
		nonce,
		expiresAt,
	)
	if err != nil {
		return "", err
	}
	return s.client.OAuthURL(oauthState, challenge), nil
}

func (s *Service) CompleteOAuth(
	ctx context.Context,
	state, code string,
) (domain.GitHubInstallation, error) {
	if state == "" || code == "" {
		return domain.GitHubInstallation{}, postgres.ErrInvalid
	}
	stateHash := HashState(state)
	attempt, err := s.store.GitHubOAuthAttempt(ctx, stateHash)
	if err != nil {
		return domain.GitHubInstallation{}, err
	}
	associatedData := []byte(strconv.FormatInt(attempt.PendingGitHubInstallationID, 10))
	verifier, err := Decrypt(
		s.stateKey,
		attempt.OAuthVerifierCiphertext,
		attempt.OAuthVerifierNonce,
		associatedData,
	)
	if err != nil {
		return domain.GitHubInstallation{}, err
	}
	accessToken, err := s.client.ExchangeOAuthCode(ctx, code, string(verifier))
	if err != nil {
		return domain.GitHubInstallation{}, err
	}
	authorized, err := s.client.UserHasInstallation(
		ctx,
		accessToken,
		attempt.PendingGitHubInstallationID,
	)
	if err != nil {
		return domain.GitHubInstallation{}, err
	}
	if !authorized {
		return domain.GitHubInstallation{}, postgres.ErrForbidden
	}
	providerInstallation, err := s.client.GetInstallation(
		ctx,
		attempt.PendingGitHubInstallationID,
	)
	if err != nil {
		return domain.GitHubInstallation{}, err
	}
	if !InstallationSupportsAuthorityProof(providerInstallation) {
		return domain.GitHubInstallation{}, postgres.ErrForbidden
	}
	authorized, err = s.client.UserCanAdministerInstallation(
		ctx,
		accessToken,
		providerInstallation,
	)
	if err != nil {
		return domain.GitHubInstallation{}, err
	}
	if !authorized {
		return domain.GitHubInstallation{}, postgres.ErrForbidden
	}
	installation, err := s.store.CompleteGitHubInstallation(
		ctx,
		stateHash,
		toDomainInstallation(providerInstallation),
	)
	if err != nil {
		return domain.GitHubInstallation{}, err
	}
	return installation, nil
}

func (s *Service) ListInstallations(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
) ([]domain.GitHubInstallation, error) {
	return s.store.ListGitHubInstallations(ctx, principal, orgID)
}

func (s *Service) SyncInstallation(
	ctx context.Context,
	principal domain.Principal,
	orgID, installationID string,
) (domain.GitHubInstallation, error) {
	installation, err := s.store.GitHubInstallationForSync(
		ctx,
		principal,
		orgID,
		installationID,
	)
	if err != nil {
		return domain.GitHubInstallation{}, err
	}
	if err := s.sync(ctx, installation); err != nil {
		return domain.GitHubInstallation{}, err
	}
	installation.SyncStatus = "ready"
	now := time.Now().UTC()
	installation.LastSyncedAt = &now
	installation.LastError = ""
	return installation, nil
}

func (s *Service) DisconnectInstallation(
	ctx context.Context,
	principal domain.Principal,
	orgID, installationID string,
) (domain.GitHubInstallation, error) {
	return s.store.DisconnectGitHubInstallation(
		ctx,
		principal,
		orgID,
		installationID,
	)
}

func (s *Service) ListRepositories(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	cursor *domain.Cursor,
	limit int,
) ([]domain.GitHubRepository, bool, error) {
	return s.store.ListGitHubRepositories(ctx, principal, orgID, cursor, limit)
}

func (s *Service) EnqueueVerifiedWebhook(
	ctx context.Context,
	delivery domain.GitHubWebhookDelivery,
) (bool, error) {
	hash := HashState(string(delivery.Payload))
	return s.store.InsertGitHubWebhook(ctx, delivery, hash)
}

func (s *Service) VerifyWebhook(payload []byte, signature string) bool {
	return VerifyWebhook(s.webhookSecret, payload, signature)
}

func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := s.processNext(ctx); err != nil &&
			!errors.Is(err, postgres.ErrNotFound) &&
			!errors.Is(err, context.Canceled) {
			s.logger.Error("process GitHub webhook", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) processNext(ctx context.Context) error {
	delivery, err := s.store.ClaimGitHubWebhook(
		ctx,
		s.workerID,
		time.Now().UTC().Add(30*time.Second),
	)
	if err != nil {
		return err
	}
	processCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	err = s.processWebhook(processCtx, delivery)
	if err == nil {
		return s.store.CompleteGitHubWebhook(ctx, delivery.DeliveryID, s.workerID)
	}
	terminal := delivery.AttemptCount >= 10 ||
		errors.Is(err, postgres.ErrInvalid)
	backoff := time.Second * time.Duration(1<<min(delivery.AttemptCount, 9))
	return s.store.RetryGitHubWebhook(
		ctx,
		delivery.DeliveryID,
		s.workerID,
		err.Error(),
		time.Now().UTC().Add(backoff),
		terminal,
	)
}

func (s *Service) processWebhook(
	ctx context.Context,
	delivery domain.GitHubWebhookDelivery,
) error {
	if delivery.GitHubInstallationID <= 0 {
		return postgres.ErrInvalid
	}
	orgID, installationID, err := s.store.GitHubInstallationRoute(
		ctx,
		delivery.GitHubInstallationID,
	)
	if err != nil {
		return err
	}
	switch delivery.Event {
	case "installation":
		action := "unsuspend"
		providerInstallation, err := s.client.GetInstallation(
			ctx,
			delivery.GitHubInstallationID,
		)
		if err != nil {
			var httpError *HTTPError
			if errors.As(err, &httpError) && httpError.StatusCode == http.StatusNotFound {
				action = "deleted"
			} else {
				return err
			}
		} else if providerInstallation.SuspendedAt != nil {
			action = "suspend"
		}
		if err := s.store.ApplyGitHubInstallationEvent(
			ctx,
			orgID,
			installationID,
			action,
		); err != nil {
			return err
		}
		if action == "suspend" || action == "deleted" {
			return nil
		}
	case "installation_repositories":
	default:
		return postgres.ErrInvalid
	}
	installation, err := s.store.GitHubInstallationByRoute(
		ctx,
		orgID,
		installationID,
	)
	if err != nil {
		return err
	}
	return s.sync(ctx, installation)
}

func (s *Service) sync(
	ctx context.Context,
	installation domain.GitHubInstallation,
) error {
	generation, err := s.store.BeginGitHubRepositorySync(ctx, installation)
	if err != nil {
		return err
	}
	providerRepositories, err := s.client.ListRepositories(
		ctx,
		installation.GitHubInstallationID,
	)
	if err != nil {
		_ = s.store.MarkGitHubSyncFailure(
			ctx,
			installation.OrgID,
			installation,
			generation,
			err.Error(),
		)
		return err
	}
	repositories := make([]domain.GitHubRepository, 0, len(providerRepositories))
	for _, repository := range providerRepositories {
		updatedAt := repository.UpdatedAt
		repositories = append(repositories, domain.GitHubRepository{
			GitHubRepositoryID: repository.ID,
			GitHubOwnerID:      repository.Owner.ID,
			Name:               repository.Name,
			FullName:           repository.FullName,
			HTMLURL:            repository.HTMLURL,
			CloneURL:           repository.CloneURL,
			SSHURL:             repository.SSHURL,
			DefaultBranch:      repository.DefaultBranch,
			Visibility:         repository.Visibility,
			IsPrivate:          repository.Private,
			IsArchived:         repository.Archived,
			IsDisabled:         repository.Disabled,
			GitHubUpdatedAt:    &updatedAt,
		})
	}
	return s.store.ReconcileGitHubRepositories(
		ctx,
		installation.OrgID,
		installation,
		generation,
		repositories,
	)
}

func toDomainInstallation(value Installation) domain.GitHubInstallation {
	permissions, _ := json.Marshal(value.Permissions)
	status := "active"
	if value.SuspendedAt != nil {
		status = "suspended"
	}
	return domain.GitHubInstallation{
		GitHubInstallationID: value.ID,
		GitHubAccountID:      value.Account.ID,
		AccountLogin:         value.Account.Login,
		AccountType:          value.Account.Type,
		Status:               status,
		RepositorySelection:  value.RepositorySelection,
		Permissions:          permissions,
		Events:               value.Events,
		SyncStatus:           "pending",
	}
}

func (s *Service) CompletionHTML(success bool) []byte {
	title := "Connection failed"
	message := "Return to AO and try connecting GitHub again."
	statusClass := "error"
	statusIcon := "!"
	buttonLabel := "Close window"
	autoClose := ""
	if success {
		title = "GitHub connected"
		message = "Repository access is ready. Return to AO to continue."
		statusClass = "success"
		statusIcon = "✓"
		autoClose = "window.setTimeout(function(){window.close()},1800);"
	}
	return []byte(fmt.Sprintf(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>%s · AO</title>
<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0b0d;color:#f4f5f7}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#0a0b0d}
main{min-height:100vh;display:grid;place-items:center;padding:32px}
.content{width:min(100%%,420px)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:44px;color:#9ba1aa;font-size:13px}
.brand img{width:30px;height:30px;border-radius:7px}
.status{display:grid;place-items:center;width:42px;height:42px;margin-bottom:20px;border:1px solid;font-size:20px;font-weight:600}
.status.success{border-color:rgba(74,222,128,.38);background:rgba(74,222,128,.08);color:#4ade80}
.status.error{border-color:rgba(212,84,79,.42);background:rgba(212,84,79,.09);color:#e16a65}
h1{margin:0;font-size:25px;line-height:1.2;letter-spacing:-.025em;font-weight:600}
p{margin:10px 0 0;color:#9ba1aa;font-size:14px;line-height:1.6}
.action{margin-top:30px;display:inline-flex;height:36px;align-items:center;justify-content:center;border:1px solid #3a3d44;border-radius:6px;background:#191b20;color:#f4f5f7;padding:0 14px;font:inherit;font-size:13px;cursor:pointer}
.action:hover{background:#22252b;border-color:#4a4e58}
.action:focus-visible{outline:2px solid #4d8dff;outline-offset:2px}
.hint{margin-top:14px;color:#646a73;font-size:12px}
@media(max-width:520px){main{place-items:start;padding:28px 22px}.brand{margin-bottom:64px}}
</style>
</head>
<body>
<main>
<section class="content" aria-labelledby="title">
<div class="brand"><img src="https://aoagents.dev/ao-logo.svg" alt=""><span>Agent Orchestrator</span></div>
<div class="status %s" aria-hidden="true">%s</div>
<h1 id="title">%s</h1>
<p>%s</p>
<button class="action" type="button" onclick="window.close()">%s</button>
<div class="hint">This window may close automatically.</div>
</section>
</main>
<script>%s</script>
</body>
</html>`,
		title,
		statusClass,
		statusIcon,
		title,
		message,
		buttonLabel,
		autoClose,
	))
}
