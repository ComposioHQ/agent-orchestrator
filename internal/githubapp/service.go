package githubapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
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
	title := "GitHub connection failed"
	message := "Return to AO and try again."
	if success {
		title = "GitHub connected"
		message = "You can close this window and return to AO."
	}
	return []byte(fmt.Sprintf(
		"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>%s</title><main><h1>%s</h1><p>%s</p></main>",
		title,
		title,
		message,
	))
}
