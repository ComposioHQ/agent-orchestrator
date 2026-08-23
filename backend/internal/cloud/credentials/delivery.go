package credentials

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
)

const claudeCredentialPath = ".claude/.credentials.json" //nolint:gosec // fixed remote path, not credential material

// DeliveryService is the only vault surface that opens encrypted material.
// It never accepts a sandbox id and never returns plaintext.
type DeliveryService struct {
	store  DeliveryStore
	opener PlaintextOpener
	limits DeliveryLimits
	slots  chan struct{}
}

// NewDeliveryService builds the bounded, acknowledgement-gated remote delivery service.
func NewDeliveryService(store DeliveryStore, opener PlaintextOpener, limits DeliveryLimits) (*DeliveryService, error) {
	if store == nil || opener == nil {
		return nil, fmt.Errorf("%w: delivery store and plaintext opener are required", ErrInvalid)
	}
	if !limits.valid() {
		return nil, fmt.Errorf("%w: invalid delivery limits", ErrInvalid)
	}
	return &DeliveryService{store: store, opener: opener, limits: limits, slots: make(chan struct{}, limits.MaxConcurrent)}, nil
}

// Deliver authorizes exclusively from a verified capability and a durable SQL
// join. Duplicate completed keys reuse the stored acknowledgement and only
// retry an idempotent purge; they never decrypt, load, or audit twice.
func (s *DeliveryService) Deliver(
	ctx context.Context,
	verified VerifiedCapability,
	provider Provider,
	idempotencyKey string,
	sink SecretFileSink,
) (LoadAcknowledgement, error) {
	if sink == nil {
		return LoadAcknowledgement{}, fmt.Errorf("%w: remote secret sink is required", ErrInvalid)
	}
	lookup, err := NewDeliveryLookup(verified, provider, idempotencyKey)
	if err != nil {
		return LoadAcknowledgement{}, err
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return LoadAcknowledgement{}, ErrLimitExceeded
	}

	claim, err := s.store.ClaimDelivery(ctx, lookup, s.limits)
	if err != nil {
		return LoadAcknowledgement{}, err
	}
	if !claim.valid() || claim.Lookup != lookup {
		return LoadAcknowledgement{}, ErrNotAuthorized
	}
	paths := providerPaths(provider)
	if claim.State == DeliveryLoaded {
		if !claim.Acknowledgement.validFor(lookup) {
			return LoadAcknowledgement{}, ErrNotAuthorized
		}
		if err := s.purge(ctx, sink, claim, paths); err != nil {
			return LoadAcknowledgement{}, ErrDeliveryFailed
		}
		if err := s.recordPurge(ctx, claim.ID); err != nil {
			return LoadAcknowledgement{}, ErrDeliveryFailed
		}
		return claim.Acknowledgement, nil
	}

	var acknowledgement LoadAcknowledgement
	openErr := s.opener.Open(ctx, claim.Credential, func(plaintext []byte) error {
		// Zeroing is deferred until after either acknowledged purge or explicit
		// failure purge. The opener must independently zero its own backing copy.
		defer Erase(plaintext)
		files, err := materialize(provider, plaintext)
		if err != nil || validateFiles(files, s.limits) != nil {
			_ = s.purge(ctx, sink, claim, paths)
			return ErrInvalid
		}
		ack, loadErr := sink.LoadCredential(ctx, LoadRequest{
			SandboxID: claim.SandboxID, IdempotencyKey: lookup.idempotencyKey,
			Provider: provider, Files: files,
		})
		if loadErr != nil || ctx.Err() != nil {
			_ = s.purge(ctx, sink, claim, paths)
			return ErrDeliveryFailed
		}
		if !ack.validFor(lookup) {
			_ = s.purge(ctx, sink, claim, paths)
			return ErrLoadNotAcknowledged
		}
		acknowledgement = ack
		if err := s.acknowledge(ctx, claim.ID, ack); err != nil {
			_ = s.purge(ctx, sink, claim, paths)
			return ErrDeliveryFailed
		}
		if err := s.purge(ctx, sink, claim, paths); err != nil {
			return ErrDeliveryFailed
		}
		if err := s.recordPurge(ctx, claim.ID); err != nil {
			return ErrDeliveryFailed
		}
		return nil
	})
	if openErr == nil {
		return acknowledgement, nil
	}
	code := failureCode(ctx, openErr)
	// Failure recording is idempotent and must not contain adapter errors.
	_ = s.recordFailure(ctx, claim.ID, code)
	if errors.Is(openErr, ErrLoadNotAcknowledged) {
		return LoadAcknowledgement{}, ErrLoadNotAcknowledged
	}
	if errors.Is(openErr, ErrInvalid) {
		return LoadAcknowledgement{}, ErrInvalid
	}
	return LoadAcknowledgement{}, ErrDeliveryFailed
}

func (s *DeliveryService) purge(ctx context.Context, sink SecretFileSink, claim DeliveryClaim, paths []string) error {
	purgeCtx, cancel := s.detachedContext(ctx)
	defer cancel()
	return sink.PurgeCredential(purgeCtx, claim.SandboxID, claim.Lookup.idempotencyKey, append([]string(nil), paths...))
}

func (s *DeliveryService) acknowledge(ctx context.Context, deliveryID string, ack LoadAcknowledgement) error {
	auditCtx, cancel := s.detachedContext(ctx)
	defer cancel()
	return s.store.AcknowledgeDelivery(auditCtx, deliveryID, ack)
}

func (s *DeliveryService) recordPurge(ctx context.Context, deliveryID string) error {
	auditCtx, cancel := s.detachedContext(ctx)
	defer cancel()
	return s.store.RecordDeliveryPurge(auditCtx, deliveryID)
}

func (s *DeliveryService) recordFailure(ctx context.Context, deliveryID string, code FailureCode) error {
	auditCtx, cancel := s.detachedContext(ctx)
	defer cancel()
	return s.store.RecordDeliveryFailure(auditCtx, deliveryID, code)
}

func (s *DeliveryService) detachedContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), s.limits.PurgeTimeout)
}

func failureCode(ctx context.Context, err error) FailureCode {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return FailureCancelled
	}
	if errors.Is(err, ErrLoadNotAcknowledged) {
		return FailureNoAck
	}
	if errors.Is(err, ErrInvalid) {
		return FailureValidation
	}
	return FailureLoad
}

func materialize(provider Provider, plaintext []byte) ([]SecretFile, error) {
	if provider != ProviderClaudeCode || len(plaintext) == 0 || len(plaintext) > MaxCredentialBytes {
		return nil, ErrInvalid
	}
	trimmed := bytes.TrimSpace(plaintext)
	// Provider credential values remain opaque mutable bytes. Decoding into a
	// Go struct or map would create unzeroable secret-bearing strings.
	if !json.Valid(trimmed) || len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return nil, ErrInvalid
	}
	return []SecretFile{{Path: claudeCredentialPath, Mode: 0o600, Content: plaintext}}, nil
}

func providerPaths(provider Provider) []string {
	if provider == ProviderClaudeCode {
		return []string{claudeCredentialPath}
	}
	return nil
}

func validateFiles(files []SecretFile, limits DeliveryLimits) error {
	if len(files) == 0 || len(files) > MaxSecretFiles {
		return ErrLimitExceeded
	}
	total := 0
	seen := make(map[string]struct{}, len(files))
	for _, file := range files {
		clean := path.Clean(file.Path)
		if file.Mode != 0o600 || path.IsAbs(file.Path) || strings.Contains(file.Path, `\`) || clean != file.Path || clean == "." || clean == ".." ||
			strings.HasPrefix(clean, "../") || len(file.Content) == 0 || len(file.Content) > limits.MaxItemBytes {
			return ErrLimitExceeded
		}
		if _, duplicate := seen[clean]; duplicate {
			return ErrLimitExceeded
		}
		seen[clean] = struct{}{}
		total += len(file.Content)
		if total > limits.MaxAggregateBytes {
			return ErrLimitExceeded
		}
	}
	return nil
}

// Erase overwrites a transient byte slice in place.
func Erase(secret []byte) {
	for index := range secret {
		secret[index] = 0
	}
}

func isZero(secret []byte) bool { return bytes.Equal(secret, make([]byte, len(secret))) }
