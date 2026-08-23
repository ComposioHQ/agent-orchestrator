package scm

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

// SignatureHeader and DeliveryHeader are the GitHub webhook headers the
// control plane requires. A delivery missing either is rejected.
const (
	SignatureHeader = "X-Hub-Signature-256"
	DeliveryHeader  = "X-GitHub-Delivery"
	EventHeader     = "X-GitHub-Event"

	signaturePrefix = "sha256="
)

// VerifyWebhookSignature checks a GitHub webhook body against the shared
// secret in constant time. The comparison covers the whole raw body: callers
// must verify before they parse, so a malformed payload cannot reach the JSON
// decoder unauthenticated.
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

// ObservationSignal is the normalized "something changed" hint a verified
// webhook produces. It carries no provider payload and no credential: the
// observer re-reads authoritative state through the installation token so a
// forged or stale delivery cannot inject facts.
type ObservationSignal struct {
	OrgID                  string
	InstallationID         string
	ExternalInstallationID int64
	Repository             string
	PullRequestNumber      int
	PullRequestURL         string
	HeadSHA                string
	Event                  string
	Action                 string
	DeliveryID             string
	ReceivedAt             time.Time
}

// ObservationSink receives verified, deduplicated SCM signals. The hosted
// observer implements it to schedule a targeted refresh.
type ObservationSink interface {
	ObserveSCMSignal(ctx context.Context, signal ObservationSignal) error
}

// WebhookStore is the persistence a webhook needs: delivery dedup, tenant
// resolution, and the narrow set of installation mutations a webhook may make.
type WebhookStore interface {
	RecordSCMWebhookDelivery(ctx context.Context, deliveryID, event string, externalInstallationID int64) (bool, error)
	SCMInstallationContext(ctx context.Context, externalInstallationID int64) (domain.SCMInstallation, error)
	SetSCMInstallationStatus(ctx context.Context, externalInstallationID int64, status string) (bool, error)
	AddSCMWebhookRepository(ctx context.Context, externalInstallationID, externalRepositoryID int64, fullName string, private bool) (bool, error)
	RemoveSCMWebhookRepository(ctx context.Context, externalInstallationID, externalRepositoryID int64) (bool, error)
}

// WebhookResult describes what one delivery did.
type WebhookResult struct {
	Event      string
	Action     string
	DeliveryID string
	// Duplicate is true when this delivery id was already processed. The
	// caller must still answer 2xx so GitHub stops retrying.
	Duplicate bool
	// Signal is non-nil when the delivery should trigger an observation.
	Signal *ObservationSignal
}

// WebhookProcessor verifies, deduplicates, and applies GitHub webhooks.
type WebhookProcessor struct {
	secret []byte
	store  WebhookStore
	sink   ObservationSink
	now    func() time.Time
}

// NewWebhookProcessor builds a processor. A missing secret is a configuration
// error rather than a permissive default: an unverified webhook endpoint would
// let anyone suspend a tenant's installation.
func NewWebhookProcessor(secret []byte, store WebhookStore, sink ObservationSink) (*WebhookProcessor, error) {
	if len(secret) == 0 {
		return nil, ErrNotConfigured
	}
	if store == nil {
		return nil, errors.New("cloud scm: webhook processor requires a store")
	}
	return &WebhookProcessor{
		secret: append([]byte(nil), secret...),
		store:  store,
		sink:   sink,
		now:    time.Now,
	}, nil
}

// webhookPayload is the union of the fields the control plane reads. Unknown
// fields are ignored: GitHub adds them freely and a stricter decoder would
// turn a harmless upstream change into an outage.
type webhookPayload struct {
	Action       string `json:"action"`
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repository struct {
		ID       int64  `json:"id"`
		FullName string `json:"full_name"`
		Private  bool   `json:"private"`
	} `json:"repository"`
	RepositoriesAdded []struct {
		ID       int64  `json:"id"`
		FullName string `json:"full_name"`
		Private  bool   `json:"private"`
	} `json:"repositories_added"`
	RepositoriesRemoved []struct {
		ID       int64  `json:"id"`
		FullName string `json:"full_name"`
	} `json:"repositories_removed"`
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

// Process handles one delivery end to end. The order is deliberate: signature
// first, then dedup, then side effects. A delivery that fails verification
// never reaches the JSON decoder or the database.
func (p *WebhookProcessor) Process(
	ctx context.Context,
	event, deliveryID, signature string,
	body []byte,
) (WebhookResult, error) {
	if err := VerifyWebhookSignature(p.secret, body, signature); err != nil {
		return WebhookResult{}, err
	}
	event = strings.TrimSpace(event)
	deliveryID = strings.TrimSpace(deliveryID)
	if event == "" || deliveryID == "" {
		return WebhookResult{}, errors.New("cloud scm: webhook event and delivery id are required")
	}
	// Claim the delivery before parsing. A signed but malformed redelivery must
	// be idempotent too, and no attacker-controlled JSON reaches the decoder
	// before signature verification and delivery-id deduplication succeed.
	first, err := p.store.RecordSCMWebhookDelivery(ctx, deliveryID, event, 0)
	if err != nil {
		return WebhookResult{}, err
	}
	result := WebhookResult{Event: event, DeliveryID: deliveryID}
	if !first {
		result.Duplicate = true
		return result, nil
	}
	var payload webhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return WebhookResult{}, errors.New("cloud scm: webhook body is not valid JSON")
	}
	result.Action = payload.Action
	if event == "ping" {
		return result, nil
	}
	if payload.Installation.ID <= 0 {
		// Nothing the control plane can attribute. Recorded for dedup, ignored
		// otherwise.
		return result, nil
	}

	switch event {
	case "installation":
		return result, p.applyInstallation(ctx, payload)
	case "installation_repositories":
		return result, p.applyInstallationRepositories(ctx, payload)
	}

	installation, err := p.store.SCMInstallationContext(ctx, payload.Installation.ID)
	if err != nil {
		// An event for an installation this control plane does not know about
		// is not an error: another AO deployment may share the app. Any other
		// failure is real and must surface so GitHub retries.
		if errors.Is(err, postgres.ErrNotFound) {
			return result, nil
		}
		return WebhookResult{}, err
	}
	if installation.Status != domain.InstallationStatusActive {
		return result, nil
	}
	signal, ok := observationSignal(event, payload)
	if !ok {
		return result, nil
	}
	signal.OrgID = installation.OrgID
	signal.InstallationID = installation.ID
	signal.ExternalInstallationID = payload.Installation.ID
	signal.Event = event
	signal.Action = payload.Action
	signal.DeliveryID = deliveryID
	signal.ReceivedAt = p.now().UTC()
	result.Signal = &signal
	if p.sink != nil {
		if err := p.sink.ObserveSCMSignal(ctx, signal); err != nil {
			return result, err
		}
	}
	return result, nil
}

func (p *WebhookProcessor) applyInstallation(ctx context.Context, payload webhookPayload) error {
	var status string
	switch payload.Action {
	case "deleted":
		status = domain.InstallationStatusRemoved
	case "suspend":
		status = domain.InstallationStatusSuspended
	case "unsuspend":
		status = domain.InstallationStatusActive
	default:
		return nil
	}
	_, err := p.store.SetSCMInstallationStatus(ctx, payload.Installation.ID, status)
	return err
}

func (p *WebhookProcessor) applyInstallationRepositories(ctx context.Context, payload webhookPayload) error {
	// Removals run first so a delivery that both adds and removes cannot leave
	// a repository reachable if the add step fails.
	for _, repository := range payload.RepositoriesRemoved {
		if repository.ID <= 0 {
			continue
		}
		if _, err := p.store.RemoveSCMWebhookRepository(ctx, payload.Installation.ID, repository.ID); err != nil {
			return err
		}
	}
	for _, repository := range payload.RepositoriesAdded {
		if repository.ID <= 0 || strings.TrimSpace(repository.FullName) == "" {
			continue
		}
		if _, err := p.store.AddSCMWebhookRepository(
			ctx, payload.Installation.ID, repository.ID, repository.FullName, repository.Private,
		); err != nil {
			return err
		}
	}
	return nil
}

// observationSignal extracts the PR coordinates a verified event refers to.
// Events that do not name a pull request produce no signal.
func observationSignal(event string, payload webhookPayload) (ObservationSignal, bool) {
	signal := ObservationSignal{
		Repository: strings.ToLower(strings.TrimSpace(payload.Repository.FullName)),
	}
	if signal.Repository == "" {
		return ObservationSignal{}, false
	}
	switch event {
	case "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread":
		if payload.PullRequest.Number <= 0 {
			return ObservationSignal{}, false
		}
		signal.PullRequestNumber = payload.PullRequest.Number
		signal.PullRequestURL = payload.PullRequest.HTMLURL
		signal.HeadSHA = payload.PullRequest.Head.SHA
	case "issue_comment":
		if payload.Issue.PullRequest == nil || payload.Issue.Number <= 0 {
			return ObservationSignal{}, false
		}
		signal.PullRequestNumber = payload.Issue.Number
		signal.PullRequestURL = payload.Issue.PullRequest.HTMLURL
	case "check_suite":
		signal.HeadSHA = payload.CheckSuite.HeadSHA
		if len(payload.CheckSuite.PullRequests) > 0 {
			signal.PullRequestNumber = payload.CheckSuite.PullRequests[0].Number
		}
	case "check_run":
		signal.HeadSHA = payload.CheckRun.HeadSHA
		if len(payload.CheckRun.CheckSuite.PullRequests) > 0 {
			signal.PullRequestNumber = payload.CheckRun.CheckSuite.PullRequests[0].Number
		}
	case "status":
		signal.HeadSHA = payload.SHA
	default:
		return ObservationSignal{}, false
	}
	if signal.PullRequestNumber <= 0 && signal.HeadSHA == "" {
		return ObservationSignal{}, false
	}
	return signal, true
}
