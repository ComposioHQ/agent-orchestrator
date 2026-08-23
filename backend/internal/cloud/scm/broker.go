package scm

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

var permissionsByPurpose = map[string]map[string]string{
	domain.TokenPurposeClone: {"contents": "read", "metadata": "read"},
	domain.TokenPurposePush:  {"contents": "write", "metadata": "read", "pull_requests": "write"},
}

type BrokerStore interface {
	AuthorizeSCMSandbox(context.Context, tenant.Identity, string) error
	AllowedSCMRepository(context.Context, tenant.Identity, string) (domain.SCMInstallation, domain.SCMRepository, error)
	RecordSCMTokenGrant(context.Context, tenant.Identity, domain.SCMTokenGrant) error
}

type InstallationTokenMinter interface {
	MintInstallationToken(context.Context, int64, int64, map[string]string) ([]byte, time.Time, error)
}

type Broker struct {
	store  BrokerStore
	minter InstallationTokenMinter
	now    func() time.Time
}

const (
	githubRepositoryHost      = "github.com"
	maxSandboxIDRunes         = 255
	maxInstallationTokenBytes = 255
)

func NewBroker(store BrokerStore, minter InstallationTokenMinter) (*Broker, error) {
	if store == nil || minter == nil {
		return nil, errors.New("cloud scm: broker requires store and token minter")
	}
	return &Broker{store: store, minter: minter, now: time.Now}, nil
}

// WithCloneCredential is the bootstrap-only delivery seam. A fresh read-only
// token exists only for the callback and is overwritten before return.
func (b *Broker) WithCloneCredential(ctx context.Context, identity tenant.Identity, repository, sandboxID string, use func(*Credential) error) error {
	return b.withCredential(ctx, identity, repository, sandboxID, domain.TokenPurposeClone, use)
}

// WithPushCredential mints and audits a fresh uncached write token for exactly
// one operation. pull_requests:write is always requested alongside contents.
func (b *Broker) WithPushCredential(ctx context.Context, identity tenant.Identity, repository, sandboxID string, use func(*Credential) error) error {
	return b.withCredential(ctx, identity, repository, sandboxID, domain.TokenPurposePush, use)
}

func (b *Broker) withCredential(ctx context.Context, identity tenant.Identity, repository, sandboxID, purpose string, use func(*Credential) error) error {
	if !identity.Valid() {
		return tenant.ErrNoTenant
	}
	if use == nil {
		return errors.New("cloud scm: credential callback is required")
	}
	canonicalSandboxID := strings.TrimSpace(sandboxID)
	if sandboxID != canonicalSandboxID || !validSandboxID(canonicalSandboxID) {
		return errors.New("cloud scm: sandbox id is invalid")
	}
	sandboxID = canonicalSandboxID
	if err := b.store.AuthorizeSCMSandbox(ctx, identity, sandboxID); err != nil {
		return err
	}
	normalized, err := NormalizeRepository(repository)
	if err != nil {
		return err
	}
	installation, allowed, err := b.store.AllowedSCMRepository(ctx, identity, normalized)
	if err != nil {
		return err
	}
	if !allowed.Allowed {
		return ErrRepositoryNotAllowed
	}
	if installation.Status != domain.InstallationStatusActive {
		return ErrInstallationInactive
	}
	allowedName, err := NormalizeRepository(allowed.FullName)
	if err != nil || allowedName != normalized {
		return ErrRepositoryNotAllowed
	}
	permissions := permissionsByPurpose[purpose]
	token, expiresAt, err := b.minter.MintInstallationToken(ctx, installation.ExternalInstallationID, allowed.ExternalRepositoryID, clonePermissions(permissions))
	if err != nil {
		return err
	}
	expiresAt = expiresAt.UTC()
	if !validInstallationToken(token) || !expiresAt.After(b.now().UTC()) {
		zeroBytes(token)
		return errors.New("cloud scm: provider returned an unusable installation token")
	}
	credential := Credential{Username: CloneUsername, Token: token, ExpiresAt: expiresAt, Repository: canonicalGitHubHTTPSRepository(allowedName)}
	defer credential.Zero()
	if err := b.store.RecordSCMTokenGrant(ctx, identity, domain.SCMTokenGrant{
		OrgID: installation.OrgID, InstallationID: installation.ID, RepositoryID: allowed.ID,
		SandboxID: sandboxID, Purpose: purpose,
		RequestedByUserID: identity.UserID, ExpiresAt: expiresAt.UTC(),
	}); err != nil {
		return err
	}
	return use(&credential)
}

func clonePermissions(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func NormalizeRepository(reference string) (string, error) {
	value := strings.TrimSpace(reference)
	if strings.HasPrefix(value, "git@") {
		const prefix = "git@" + githubRepositoryHost + ":"
		if !strings.HasPrefix(value, prefix) {
			return "", ErrInvalidRepository
		}
		return normalizeRepositoryPath(strings.TrimPrefix(value, prefix))
	}
	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawPath != "" || parsed.Port() != "" {
			return "", ErrInvalidRepository
		}
		switch parsed.Scheme {
		case "https":
			if parsed.Host != githubRepositoryHost || parsed.User != nil {
				return "", ErrInvalidRepository
			}
		case "ssh":
			if parsed.Host != githubRepositoryHost || parsed.User == nil || parsed.User.String() != "git" {
				return "", ErrInvalidRepository
			}
		default:
			return "", ErrInvalidRepository
		}
		return normalizeRepositoryPath(strings.TrimPrefix(parsed.Path, "/"))
	}
	return normalizeRepositoryPath(value)
}

func normalizeRepositoryPath(value string) (string, error) {
	if value != strings.TrimSpace(value) || strings.HasSuffix(value, "/") {
		return "", ErrInvalidRepository
	}
	value = strings.TrimSuffix(value, ".git")
	parts := strings.Split(strings.ToLower(value), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.ContainsAny(value, "@ :\\?#\t") || containsInvalidRepositoryRune(value) {
		return "", ErrInvalidRepository
	}
	return parts[0] + "/" + parts[1], nil
}

func containsInvalidRepositoryRune(value string) bool {
	return !utf8.ValidString(value) || strings.IndexFunc(value, func(character rune) bool {
		return unicode.IsControl(character) || unicode.IsSpace(character)
	}) >= 0
}

func canonicalGitHubHTTPSRepository(fullName string) string {
	return "https://" + githubRepositoryHost + "/" + fullName + ".git"
}

func validSandboxID(value string) bool {
	return value != "" && utf8.ValidString(value) && utf8.RuneCountInString(value) <= maxSandboxIDRunes &&
		strings.IndexFunc(value, unicode.IsControl) < 0
}

func zeroBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func validInstallationToken(token []byte) bool {
	if len(token) < len("ghs_")+1 || len(token) > maxInstallationTokenBytes || !bytes.HasPrefix(token, []byte("ghs_")) {
		return false
	}
	for _, character := range token[len("ghs_"):] {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') {
			return false
		}
	}
	return true
}
