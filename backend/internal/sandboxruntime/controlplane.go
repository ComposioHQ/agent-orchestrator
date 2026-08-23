package sandboxruntime

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const controlPlaneRequestTimeout = 15 * time.Second

// ControlPlaneClient makes authenticated calls from the sandbox to the public
// control plane. It retains only non-secret connection configuration. The
// bearer is reopened from CapabilityPath for each call and zeroed immediately
// after the transport finishes.
type ControlPlaneClient struct {
	baseURL        *url.URL
	httpClient     *http.Client
	capabilityPath string
	expectedUID    uint32
}

// NewControlPlaneClient validates the public control-plane URL and constructs
// a client with normal certificate and hostname verification. roots is nil in
// production to use the platform trust store; tests and private deployments may
// add an explicit trust bundle without disabling verification.
func NewControlPlaneClient(rawURL string, expectedUID uint32, roots *x509.CertPool) (*ControlPlaneClient, error) {
	baseURL, err := parseControlPlaneURL(rawURL)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    roots,
	}
	return &ControlPlaneClient{
		baseURL:        baseURL,
		httpClient:     &http.Client{Transport: transport, Timeout: controlPlaneRequestTimeout},
		capabilityPath: CapabilityPath,
		expectedUID:    expectedUID,
	}, nil
}

func parseControlPlaneURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("parse control-plane URL: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host == "" {
		return nil, errors.New("control-plane URL must be an absolute https URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("control-plane URL must not contain credentials, query, or fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed, nil
}

func (c *ControlPlaneClient) endpoint(route string) (string, error) {
	if c == nil || c.baseURL == nil {
		return "", errors.New("control-plane client is not configured")
	}
	if !strings.HasPrefix(route, "/") || strings.HasPrefix(route, "//") {
		return "", errors.New("control-plane route must be absolute-path relative")
	}
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + route
	return endpoint.String(), nil
}

// doAuthenticated sends one request using the raw file bearer. Response bodies
// are never folded into errors: a peer or proxy that reflects Authorization
// must not make the capability appear in logs.
func (c *ControlPlaneClient) doAuthenticated(ctx context.Context, method, route string, body io.Reader) (*http.Response, error) {
	endpoint, err := c.endpoint(route)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, fmt.Errorf("build control-plane request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	var response *http.Response
	err = withCapabilityAt(c.capabilityPath, c.expectedUID, func(raw []byte) error {
		// net/http requires a string field value. Keep this conversion inside the
		// transport call, delete the header before returning, and let
		// withCapabilityAt zero the source bytes immediately afterwards.
		authorization := "Bearer " + string(raw)
		req.Header.Set("Authorization", authorization)
		defer func() {
			req.Header.Del("Authorization")
			authorization = ""
		}()

		response, err = c.httpClient.Do(req)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("control-plane request failed: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_ = response.Body.Close()
		return nil, fmt.Errorf("control-plane request failed with status %d", response.StatusCode)
	}
	return response, nil
}
