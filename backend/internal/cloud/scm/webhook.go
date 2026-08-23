package scm

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

const (
	SignatureHeader     = "X-Hub-Signature-256"
	DeliveryHeader      = "X-GitHub-Delivery"
	EventHeader         = "X-GitHub-Event"
	MaxWebhookBodyBytes = 2 << 20

	signaturePrefix         = "sha256="
	webhookErrorInvalidJSON = "invalid_json"
	webhookErrorProcessing  = "processing_failed"
)

// WebhookStore deliberately exposes one ingest operation. There is no API
// that can reserve a delivery id without durably storing its body and state.
type WebhookStore interface {
	IngestAndClaimSCMWebhook(context.Context, domain.SCMWebhookReceipt) (domain.SCMWebhookClaim, error)
	ClaimDueSCMWebhooks(context.Context, int) ([]domain.SCMWebhookClaim, error)
	FinishSCMWebhook(context.Context, string, string, string, string) (bool, error)
}

// ObservationSignal is a normalized refresh hint, not authoritative provider
// state. Consumers re-read GitHub before writing observation facts.
type ObservationSignal struct {
	ExternalInstallationID int64
	Repository             string
	PullRequestNumber      int
	PullRequestURL         string
	HeadSHA                string
	Event                  string
	Action                 string
}

// ObservationSink must make its durable write idempotent on deliveryID. The
// separate required parameter makes omitting the dedup key impossible at the
// call boundary and permits safe replay after a crash before FinishSCMWebhook.
type ObservationSink interface {
	ObserveSCMSignal(context.Context, string, ObservationSignal) error
}

type WebhookResult struct {
	DeliveryID string
	Event      string
	Duplicate  bool
	Durable    bool
	Terminal   bool
	Signal     *ObservationSignal
}

type WebhookProcessor struct {
	secret []byte
	store  WebhookStore
	sink   ObservationSink
}

func NewWebhookProcessor(secret []byte, store WebhookStore, sink ObservationSink) (*WebhookProcessor, error) {
	if len(secret) == 0 {
		return nil, ErrNotConfigured
	}
	if store == nil {
		return nil, errors.New("cloud scm: webhook processor requires a store")
	}
	return &WebhookProcessor{secret: append([]byte(nil), secret...), store: store, sink: sink}, nil
}

func VerifyWebhookSignature(secret, body []byte, header string) error {
	if len(secret) == 0 {
		return ErrNotConfigured
	}
	header = strings.TrimSpace(header)
	if !strings.HasPrefix(header, signaturePrefix) {
		return ErrInvalidSignature
	}
	provided, err := hex.DecodeString(strings.TrimPrefix(header, signaturePrefix))
	if err != nil {
		return ErrInvalidSignature
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return ErrInvalidSignature
	}
	return nil
}

// Process verifies before durability, then acknowledges responsibility once
// the complete receipt is durably terminal or leased. Callers may return 202
// for every result with Durable set, even when the returned processing error
// asks the internal retry loop to recover work.
func (p *WebhookProcessor) Process(ctx context.Context, event, deliveryID, signature string, body []byte) (WebhookResult, error) {
	if len(body) > MaxWebhookBodyBytes {
		return WebhookResult{}, ErrPayloadTooLarge
	}
	if err := VerifyWebhookSignature(p.secret, body, signature); err != nil {
		return WebhookResult{}, err
	}
	event = strings.TrimSpace(event)
	deliveryID = strings.TrimSpace(deliveryID)
	if event == "" || deliveryID == "" {
		return WebhookResult{}, ErrInvalidWebhookHeaders
	}

	classification, terminalError := classifyWebhook(event, body)
	claim, err := p.store.IngestAndClaimSCMWebhook(ctx, domain.SCMWebhookReceipt{
		Provider:       domain.SCMProviderGitHub,
		DeliveryID:     deliveryID,
		Event:          event,
		Body:           append([]byte(nil), body...),
		Classification: classification,
		TerminalError:  terminalError,
	})
	if err != nil {
		return WebhookResult{}, errors.Join(ErrWebhookReceiptUnavailable, err)
	}
	result := WebhookResult{
		DeliveryID: deliveryID,
		Event:      event,
		Duplicate:  !claim.FirstReceipt,
		Durable:    true,
		Terminal:   claim.State == domain.SCMWebhookStateDeadLetter,
	}
	if !claim.Claimed {
		return result, nil
	}
	return p.processClaim(ctx, claim, result)
}

func (p *WebhookProcessor) RetryPending(ctx context.Context, limit int) (int, error) {
	claims, err := p.store.ClaimDueSCMWebhooks(ctx, limit)
	if err != nil {
		return 0, err
	}
	var joined error
	for _, claim := range claims {
		_, processErr := p.processClaim(ctx, claim, WebhookResult{
			DeliveryID: claim.DeliveryID,
			Event:      claim.Event,
			Durable:    true,
		})
		joined = errors.Join(joined, processErr)
	}
	return len(claims), joined
}

func (p *WebhookProcessor) processClaim(ctx context.Context, claim domain.SCMWebhookClaim, result WebhookResult) (WebhookResult, error) {
	if claim.Classification == domain.SCMWebhookClassificationObservation {
		signal, ok := observationSignal(claim.Event, claim.Body)
		if !ok {
			return p.retryClaim(ctx, claim, result, errors.New("cloud scm: durable webhook classification no longer matches payload"))
		}
		result.Signal = &signal
		if p.sink != nil {
			if err := p.sink.ObserveSCMSignal(ctx, claim.DeliveryID, signal); err != nil {
				return p.retryClaim(ctx, claim, result, err)
			}
		}
	}
	finished, err := p.store.FinishSCMWebhook(
		ctx, claim.DeliveryID, claim.LeaseID, domain.SCMWebhookOutcomeComplete, "",
	)
	if err != nil {
		return result, err
	}
	if !finished {
		return result, ErrWebhookLeaseLost
	}
	return result, nil
}

func (p *WebhookProcessor) retryClaim(ctx context.Context, claim domain.SCMWebhookClaim, result WebhookResult, cause error) (WebhookResult, error) {
	finished, err := p.store.FinishSCMWebhook(
		ctx, claim.DeliveryID, claim.LeaseID, domain.SCMWebhookOutcomeRetry, webhookErrorProcessing,
	)
	if err != nil {
		return result, errors.Join(cause, err)
	}
	if !finished {
		return result, errors.Join(cause, ErrWebhookLeaseLost)
	}
	return result, cause
}

func classifyWebhook(event string, body []byte) (classification, terminalError string) {
	if !json.Valid(body) {
		return domain.SCMWebhookClassificationMalformed, webhookErrorInvalidJSON
	}
	if _, ok := observationSignal(event, body); ok {
		return domain.SCMWebhookClassificationObservation, ""
	}
	return domain.SCMWebhookClassificationIgnored, ""
}

type webhookPayload struct {
	Action       string `json:"action"`
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	PullRequest struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		Head    struct {
			SHA string `json:"sha"`
		} `json:"head"`
	} `json:"pull_request"`
	Issue struct {
		Number      int `json:"number"`
		PullRequest *struct {
			HTMLURL string `json:"html_url"`
		} `json:"pull_request"`
	} `json:"issue"`
	CheckSuite struct {
		HeadSHA      string `json:"head_sha"`
		PullRequests []struct {
			Number int `json:"number"`
		} `json:"pull_requests"`
	} `json:"check_suite"`
	CheckRun struct {
		HeadSHA    string `json:"head_sha"`
		CheckSuite struct {
			PullRequests []struct {
				Number int `json:"number"`
			} `json:"pull_requests"`
		} `json:"check_suite"`
	} `json:"check_run"`
	SHA string `json:"sha"`
}

func observationSignal(event string, body []byte) (ObservationSignal, bool) {
	var payload webhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return ObservationSignal{}, false
	}
	signal := ObservationSignal{
		ExternalInstallationID: payload.Installation.ID,
		Repository:             strings.ToLower(strings.TrimSpace(payload.Repository.FullName)),
		Event:                  event,
		Action:                 payload.Action,
	}
	if signal.Repository == "" || signal.ExternalInstallationID <= 0 {
		return ObservationSignal{}, false
	}
	switch event {
	case "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread":
		signal.PullRequestNumber = payload.PullRequest.Number
		signal.PullRequestURL = payload.PullRequest.HTMLURL
		signal.HeadSHA = payload.PullRequest.Head.SHA
	case "issue_comment":
		if payload.Issue.PullRequest == nil {
			return ObservationSignal{}, false
		}
		signal.PullRequestNumber = payload.Issue.Number
		signal.PullRequestURL = payload.Issue.PullRequest.HTMLURL
	case "check_suite":
		signal.HeadSHA = payload.CheckSuite.HeadSHA
		if len(payload.CheckSuite.PullRequests) != 0 {
			signal.PullRequestNumber = payload.CheckSuite.PullRequests[0].Number
		}
	case "check_run":
		signal.HeadSHA = payload.CheckRun.HeadSHA
		if len(payload.CheckRun.CheckSuite.PullRequests) != 0 {
			signal.PullRequestNumber = payload.CheckRun.CheckSuite.PullRequests[0].Number
		}
	case "status":
		signal.HeadSHA = payload.SHA
	default:
		return ObservationSignal{}, false
	}
	if signal.PullRequestNumber <= 0 && strings.TrimSpace(signal.HeadSHA) == "" {
		return ObservationSignal{}, false
	}
	return signal, true
}
