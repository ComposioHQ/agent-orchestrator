package sandboxruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const maxRedemptionResponse = 64 << 10

const terminalTicketConsumePath = "/api/cloud/v1/sandbox/terminal-tickets/consume"

// Ticket scopes are deliberately narrow and independently enforced.
const (
	ScopeTerminalRead     = "terminal:read"
	ScopeTerminalOperate  = "terminal:operate"
	ScopeWorkspaceObserve = "workspace:observe"
)

// ErrTicketRejected is intentionally generic so rejected secrets never reach logs.
var ErrTicketRejected = errors.New("sandbox ticket rejected")

// TicketGrant is the online control plane's authoritative decision. A grant is
// usable only for the configured sandbox/workspace/session tuple.
type TicketGrant struct {
	SandboxID   string    `json:"sandboxId"`
	WorkspaceID string    `json:"workspaceId"`
	SessionID   string    `json:"sessionId"`
	Scopes      []string  `json:"scopes"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

// HasScope reports whether the online grant includes one exact operation.
func (g TicketGrant) HasScope(scope string) bool {
	for _, candidate := range g.Scopes {
		if candidate == scope {
			return true
		}
	}
	return false
}

// ControlPlaneRedeemer consumes one opaque ticket at the control plane. Its
// implementation must make redemption and consumption one atomic operation;
// the sandbox intentionally carries no signing key or replay database.
type ControlPlaneRedeemer interface {
	Redeem(ctx context.Context, ticket string) (TicketGrant, error)
}

// HTTPControlPlaneRedeemer consumes tickets through a verified HTTPS request.
type HTTPControlPlaneRedeemer struct {
	endpoint   string
	client     *http.Client
	target     TicketGrant
	capability CapabilityReader
}

// NewControlPlaneRedeemer creates an online redeemer using Go's normal TLS
// verification. Plain HTTP and custom insecure transports are not supported.
func NewControlPlaneRedeemer(controlPlaneURL string, capability CapabilityReader, target TicketGrant) (*HTTPControlPlaneRedeemer, error) {
	u, err := url.Parse(controlPlaneURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil, errors.New("control plane URL must be an absolute HTTPS URL without user info")
	}
	if capability == nil {
		return nil, errors.New("sandbox capability reader is required")
	}
	u.Path = terminalTicketConsumePath
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	defaultTransport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default HTTP transport is unavailable")
	}
	transport := defaultTransport.Clone()
	return &HTTPControlPlaneRedeemer{
		endpoint: u.String(),
		client: &http.Client{
			Transport: transport,
			Timeout:   10 * time.Second,
			// A redirect could replay the request body, including the opaque
			// ticket, to another origin. Redemption endpoints never redirect.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("ticket redemption redirects are not accepted")
			},
		},
		target:     target,
		capability: capability,
	}, nil
}

type redemptionRequest struct {
	Ticket      string `json:"ticket"`
	SandboxID   string `json:"sandboxId"`
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
}

// Redeem atomically consumes ticket at the configured control-plane endpoint.
func (r *HTTPControlPlaneRedeemer) Redeem(ctx context.Context, ticket string) (TicketGrant, error) {
	if ticket == "" {
		return TicketGrant{}, ErrTicketRejected
	}
	capability, err := r.capability.ReadCapability()
	if err != nil {
		return TicketGrant{}, errors.New("read sandbox capability")
	}
	body, err := json.Marshal(redemptionRequest{
		Ticket: ticket, SandboxID: r.target.SandboxID,
		WorkspaceID: r.target.WorkspaceID, SessionID: r.target.SessionID,
	})
	if err != nil {
		return TicketGrant{}, errors.New("encode ticket redemption")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint, bytes.NewReader(body))
	if err != nil {
		return TicketGrant{}, errors.New("create ticket redemption request")
	}
	req.Header.Set("Content-Type", "application/json")
	// This bearer is the rotating sandbox-to-control-plane capability. The
	// terminal ticket remains solely in the JSON body after arriving through
	// ao.ticket.<opaque>; it is never used as bearer authorization.
	req.Header.Set("Authorization", "Bearer "+string(capability))
	resp, err := r.client.Do(req)
	if err != nil {
		return TicketGrant{}, errors.New("control plane ticket redemption failed")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxRedemptionResponse))
		return TicketGrant{}, ErrTicketRejected
	}
	var grant TicketGrant
	dec := json.NewDecoder(io.LimitReader(resp.Body, maxRedemptionResponse))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&grant); err != nil {
		return TicketGrant{}, errors.New("decode ticket redemption response")
	}
	if err := validateGrant(grant, r.target); err != nil {
		return TicketGrant{}, err
	}
	return grant, nil
}

func validateGrant(grant, target TicketGrant) error {
	if grant.SandboxID != target.SandboxID || grant.WorkspaceID != target.WorkspaceID || grant.SessionID != target.SessionID {
		return ErrTicketRejected
	}
	if grant.ExpiresAt.IsZero() || !grant.ExpiresAt.After(time.Now()) {
		return ErrTicketRejected
	}
	if len(grant.Scopes) == 0 {
		return ErrTicketRejected
	}
	return nil
}

func redeemForScope(ctx context.Context, redeemer ControlPlaneRedeemer, ticket, scope string, target TicketGrant) (TicketGrant, error) {
	grant, err := redeemer.Redeem(ctx, ticket)
	if err != nil {
		return TicketGrant{}, ErrTicketRejected
	}
	if err := validateGrant(grant, target); err != nil || !grant.HasScope(scope) {
		return TicketGrant{}, ErrTicketRejected
	}
	return grant, nil
}

func authorizationTicket(r *http.Request) (string, error) {
	// There is deliberately no Authorization/Bearer compatibility path.
	if r.Header.Get("Authorization") != "" {
		return "", fmt.Errorf("%w: bearer authorization is not accepted", ErrTicketRejected)
	}
	ticket := r.Header.Get("X-AO-Ticket")
	if ticket == "" {
		return "", ErrTicketRejected
	}
	return ticket, nil
}
