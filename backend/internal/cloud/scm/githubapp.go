package scm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultGitHubAPIBase = "https://api.github.com"
	defaultGitHubWebBase = "https://github.com"
	githubAcceptHeader   = "application/vnd.github+json"
	githubAPIVersion     = "2022-11-28"
	appUserAgent         = "ao-cloud/scm-github-app"
	// maxProviderResponseBytes bounds what the control plane will read from
	// GitHub so a hostile or broken upstream cannot exhaust memory.
	maxProviderResponseBytes = 4 << 20
	repositoryPageSize       = 100
	maxRepositoryPages       = 50
)

// AppClient talks to the GitHub App endpoints the credential boundary needs.
// It is deliberately small: every call here either establishes an installation
// link or mints a scoped credential.
type AppClient struct {
	credentials  *AppCredentials
	http         *http.Client
	apiBase      string
	webBase      string
	oauthClient  string
	oauthSecret  string
	requireOAuth bool
}

// AppClientOptions configures an AppClient. Tests point APIBase and WebBase at
// an httptest server; production leaves them empty.
type AppClientOptions struct {
	Credentials *AppCredentials
	HTTPClient  *http.Client
	APIBase     string
	WebBase     string
	// OAuthClientID and OAuthClientSecret enable the user-authorization leg of
	// the install flow. When set, a completing user must prove access to the
	// installation with their own short-lived OAuth code.
	OAuthClientID     string
	OAuthClientSecret string
}

// NewAppClient validates the app configuration and builds a client.
func NewAppClient(options AppClientOptions) (*AppClient, error) {
	if options.Credentials == nil {
		return nil, ErrNotConfigured
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	client := &AppClient{
		credentials: options.Credentials,
		http:        httpClient,
		apiBase:     strings.TrimRight(valueOr(options.APIBase, defaultGitHubAPIBase), "/"),
		webBase:     strings.TrimRight(valueOr(options.WebBase, defaultGitHubWebBase), "/"),
		oauthClient: strings.TrimSpace(options.OAuthClientID),
		oauthSecret: strings.TrimSpace(options.OAuthClientSecret),
	}
	client.requireOAuth = client.oauthClient != "" && client.oauthSecret != ""
	return client, nil
}

// Credentials exposes the app identity for callers that need the bot login or
// slug. The private key stays inside AppCredentials.
func (c *AppClient) Credentials() *AppCredentials { return c.credentials }

// RequiresUserAuthorization reports whether install completion must present a
// user OAuth code.
func (c *AppClient) RequiresUserAuthorization() bool { return c.requireOAuth }

// InstallURL is where a user is sent to install the app. State is echoed back
// to the setup callback and binds the redirect to the requesting user.
func (c *AppClient) InstallURL(state string) string {
	return fmt.Sprintf(
		"%s/apps/%s/installations/new?state=%s",
		c.webBase,
		url.PathEscape(c.credentials.Slug()),
		url.QueryEscape(state),
	)
}

// InstallationAccount describes an installation as GitHub reports it.
type InstallationAccount struct {
	ExternalID          int64
	AccountLogin        string
	AccountType         string
	AppSlug             string
	RepositorySelection string
	Suspended           bool
}

type restInstallation struct {
	ID      int64 `json:"id"`
	Account struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"account"`
	AppSlug             string `json:"app_slug"`
	RepositorySelection string `json:"repository_selection"`
	SuspendedAt         string `json:"suspended_at"`
}

// Installation reads one installation with an app-level assertion. It is the
// authoritative check that an installation id from a redirect is real and
// belongs to this app.
func (c *AppClient) Installation(ctx context.Context, externalID int64) (InstallationAccount, error) {
	if externalID <= 0 {
		return InstallationAccount{}, ErrInstallationNotFound
	}
	assertion, err := c.credentials.JWT()
	if err != nil {
		return InstallationAccount{}, err
	}
	body, err := c.do(ctx, http.MethodGet, c.apiBase+"/app/installations/"+strconv.FormatInt(externalID, 10), "Bearer "+assertion, nil)
	if err != nil {
		return InstallationAccount{}, err
	}
	var payload restInstallation
	if err := json.Unmarshal(body, &payload); err != nil {
		return InstallationAccount{}, fmt.Errorf("cloud scm: decode installation: %w", err)
	}
	if payload.ID == 0 {
		return InstallationAccount{}, ErrInstallationNotFound
	}
	return InstallationAccount{
		ExternalID:          payload.ID,
		AccountLogin:        payload.Account.Login,
		AccountType:         normalizeAccountType(payload.Account.Type),
		AppSlug:             valueOr(payload.AppSlug, c.credentials.Slug()),
		RepositorySelection: normalizeRepositorySelection(payload.RepositorySelection),
		Suspended:           strings.TrimSpace(payload.SuspendedAt) != "",
	}, nil
}

// InstallationToken is a minted, repository-scoped installation credential.
// The Token field is secret: it must never be logged, persisted, or echoed in
// an error envelope.
type InstallationToken struct {
	Token     Secret
	ExpiresAt time.Time
}

// TokenRequest narrows a minted credential to specific repositories and
// permissions. An empty RepositoryIDs slice is rejected by the broker: an
// unscoped installation token is exactly what this boundary exists to prevent.
type TokenRequest struct {
	ExternalInstallationID int64
	RepositoryIDs          []int64
	Permissions            map[string]string
}

type restInstallationToken struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CreateInstallationToken mints a scoped installation access token.
func (c *AppClient) CreateInstallationToken(ctx context.Context, request TokenRequest) (InstallationToken, error) {
	if request.ExternalInstallationID <= 0 {
		return InstallationToken{}, ErrInstallationNotFound
	}
	if len(request.RepositoryIDs) == 0 {
		return InstallationToken{}, errors.New("cloud scm: installation tokens must be repository-scoped")
	}
	if len(request.Permissions) == 0 {
		return InstallationToken{}, errors.New("cloud scm: installation tokens must request explicit permissions")
	}
	assertion, err := c.credentials.JWT()
	if err != nil {
		return InstallationToken{}, err
	}
	payload, err := json.Marshal(map[string]any{
		"repository_ids": request.RepositoryIDs,
		"permissions":    request.Permissions,
	})
	if err != nil {
		return InstallationToken{}, err
	}
	body, err := c.do(
		ctx,
		http.MethodPost,
		c.apiBase+"/app/installations/"+strconv.FormatInt(request.ExternalInstallationID, 10)+"/access_tokens",
		"Bearer "+assertion,
		payload,
	)
	if err != nil {
		return InstallationToken{}, err
	}
	var decoded restInstallationToken
	if err := json.Unmarshal(body, &decoded); err != nil {
		return InstallationToken{}, errors.New("cloud scm: decode installation token response")
	}
	if strings.TrimSpace(decoded.Token) == "" || decoded.ExpiresAt.IsZero() {
		return InstallationToken{}, errors.New("cloud scm: provider returned an unusable installation token")
	}
	return InstallationToken{Token: NewSecret(decoded.Token), ExpiresAt: decoded.ExpiresAt.UTC()}, nil
}

// RepositoryRef is one repository an installation can see.
type RepositoryRef struct {
	ExternalID int64
	FullName   string
	Private    bool
}

type restRepositoryPage struct {
	TotalCount   int `json:"total_count"`
	Repositories []struct {
		ID       int64  `json:"id"`
		FullName string `json:"full_name"`
		Private  bool   `json:"private"`
	} `json:"repositories"`
}

// ListInstallationRepositories enumerates what an installation can see. It
// mints a short-lived installation-wide token for the read and discards it;
// the token is never returned to a caller and never leaves this function.
func (c *AppClient) ListInstallationRepositories(ctx context.Context, externalID int64) ([]RepositoryRef, error) {
	assertion, err := c.credentials.JWT()
	if err != nil {
		return nil, err
	}
	tokenBody, err := c.do(
		ctx,
		http.MethodPost,
		c.apiBase+"/app/installations/"+strconv.FormatInt(externalID, 10)+"/access_tokens",
		"Bearer "+assertion,
		[]byte(`{"permissions":{"metadata":"read"}}`),
	)
	if err != nil {
		return nil, err
	}
	var minted restInstallationToken
	if err := json.Unmarshal(tokenBody, &minted); err != nil {
		return nil, errors.New("cloud scm: decode installation token response")
	}
	if strings.TrimSpace(minted.Token) == "" {
		return nil, errors.New("cloud scm: provider returned an unusable installation token")
	}
	authorization := "token " + minted.Token
	repositories := make([]RepositoryRef, 0, repositoryPageSize)
	for page := 1; page <= maxRepositoryPages; page++ {
		listURL := fmt.Sprintf(
			"%s/installation/repositories?per_page=%d&page=%d",
			c.apiBase, repositoryPageSize, page,
		)
		body, listErr := c.do(ctx, http.MethodGet, listURL, authorization, nil)
		if listErr != nil {
			return nil, listErr
		}
		var decoded restRepositoryPage
		if err := json.Unmarshal(body, &decoded); err != nil {
			return nil, errors.New("cloud scm: decode installation repositories")
		}
		for _, repository := range decoded.Repositories {
			fullName := strings.ToLower(strings.TrimSpace(repository.FullName))
			if repository.ID <= 0 || fullName == "" {
				continue
			}
			repositories = append(repositories, RepositoryRef{
				ExternalID: repository.ID,
				FullName:   fullName,
				Private:    repository.Private,
			})
		}
		if len(decoded.Repositories) < repositoryPageSize {
			break
		}
	}
	return repositories, nil
}

// VerifyUserInstallation exchanges a one-time OAuth code for a user token and
// checks that the user can actually see the installation they are linking.
// The user token is used for that single check and then dropped; it is never
// persisted or returned.
func (c *AppClient) VerifyUserInstallation(ctx context.Context, code string, externalInstallationID int64) error {
	if !c.requireOAuth {
		return nil
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return ErrInstallationNotOwned
	}
	form := url.Values{}
	form.Set("client_id", c.oauthClient)
	form.Set("client_secret", c.oauthSecret)
	form.Set("code", code)
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.webBase+"/login/oauth/access_token", strings.NewReader(form.Encode()),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("User-Agent", appUserAgent)
	body, err := c.send(request)
	if err != nil {
		return err
	}
	var exchange struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.Unmarshal(body, &exchange); err != nil {
		return errors.New("cloud scm: decode oauth exchange response")
	}
	if strings.TrimSpace(exchange.AccessToken) == "" {
		return ErrInstallationNotOwned
	}
	authorization := "token " + exchange.AccessToken
	for page := 1; page <= maxRepositoryPages; page++ {
		listURL := fmt.Sprintf("%s/user/installations?per_page=%d&page=%d", c.apiBase, repositoryPageSize, page)
		listBody, listErr := c.do(ctx, http.MethodGet, listURL, authorization, nil)
		if listErr != nil {
			return listErr
		}
		var decoded struct {
			Installations []struct {
				ID int64 `json:"id"`
			} `json:"installations"`
		}
		if err := json.Unmarshal(listBody, &decoded); err != nil {
			return errors.New("cloud scm: decode user installations")
		}
		for _, installation := range decoded.Installations {
			if installation.ID == externalInstallationID {
				return nil
			}
		}
		if len(decoded.Installations) < repositoryPageSize {
			break
		}
	}
	return ErrInstallationNotOwned
}

func (c *AppClient) do(ctx context.Context, method, endpoint, authorization string, body []byte) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", githubAcceptHeader)
	request.Header.Set("X-GitHub-Api-Version", githubAPIVersion)
	request.Header.Set("User-Agent", appUserAgent)
	request.Header.Set("Authorization", authorization)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return c.send(request)
}

// send performs the request and classifies failures by status alone. Response
// bodies from GitHub can echo request material, so they never reach an error.
func (c *AppClient) send(request *http.Request) ([]byte, error) {
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("cloud scm: %s %s: %w", request.Method, request.URL.Path, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxProviderResponseBytes))
		_ = response.Body.Close()
	}()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxProviderResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("cloud scm: read %s response: %w", request.URL.Path, err)
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		return nil, ErrInstallationNotFound
	case response.StatusCode == http.StatusUnauthorized, response.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%w: status %d", ErrProviderRejected, response.StatusCode)
	case response.StatusCode >= 300:
		return nil, fmt.Errorf("%w: status %d", ErrProviderRejected, response.StatusCode)
	}
	return body, nil
}

func valueOr(value, fallback string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return fallback
}

func normalizeAccountType(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "User") {
		return "User"
	}
	return "Organization"
}

func normalizeRepositorySelection(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "all") {
		return "all"
	}
	return "selected"
}
