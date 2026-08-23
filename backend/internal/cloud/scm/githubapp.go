package scm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultGitHubAPIBase     = "https://api.github.com"
	defaultGitHubWebBase     = "https://github.com"
	githubAcceptHeader       = "application/vnd.github+json"
	githubAPIVersion         = "2022-11-28"
	githubUserAgent          = "ao-cloud/scm-github-app"
	maxProviderResponseBytes = 4 << 20
	repositoryPageSize       = 100
	maxRepositoryPages       = 50
	defaultGitHubHTTPTimeout = 20 * time.Second
)

// AppClientOptions configures the isolated GitHub App HTTP client.
type AppClientOptions struct {
	Credentials       *AppCredentials
	HTTPClient        *http.Client
	APIBase           string
	WebBase           string
	OAuthClientID     string
	OAuthClientSecret string
}

// AppClient implements app identity, installation discovery, and token minting.
type AppClient struct {
	credentials *AppCredentials
	http        *http.Client
	apiBase     string
	webBase     string
	oauthID     string
	oauthSecret string
}

// NewAppClient validates trusted provider bases and disables credential-bearing redirects.
func NewAppClient(options AppClientOptions) (*AppClient, error) {
	if options.Credentials == nil {
		return nil, ErrNotConfigured
	}
	apiBase, err := normalizeProviderBase(options.APIBase, defaultGitHubAPIBase)
	if err != nil {
		return nil, fmt.Errorf("cloud scm: github API base: %w", err)
	}
	webBase, err := normalizeProviderBase(options.WebBase, defaultGitHubWebBase)
	if err != nil {
		return nil, fmt.Errorf("cloud scm: github web base: %w", err)
	}
	oauthID := strings.TrimSpace(options.OAuthClientID)
	oauthSecret := strings.TrimSpace(options.OAuthClientSecret)
	if (oauthID == "") != (oauthSecret == "") {
		return nil, errors.New("cloud scm: github OAuth client id and secret must be configured together")
	}
	httpClient := &http.Client{Timeout: defaultGitHubHTTPTimeout}
	if options.HTTPClient != nil {
		clone := *options.HTTPClient
		httpClient = &clone
		if httpClient.Timeout <= 0 {
			httpClient.Timeout = defaultGitHubHTTPTimeout
		}
	}
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("cloud scm: github redirect refused")
	}
	return &AppClient{
		credentials: options.Credentials,
		http:        httpClient, apiBase: apiBase, webBase: webBase,
		oauthID: oauthID, oauthSecret: oauthSecret,
	}, nil
}

// RequiresUserAuthorization reports whether callback ownership can be verified.
func (c *AppClient) RequiresUserAuthorization() bool {
	return c.oauthID != "" && c.oauthSecret != ""
}

// InstallURL returns the app installation URL carrying an opaque state token.
func (c *AppClient) InstallURL(state string) string {
	return c.webBase + "/apps/" + url.PathEscape(c.credentials.Slug()) +
		"/installations/new?state=" + url.QueryEscape(state)
}

// AuthorizationURL starts the distinct GitHub user web-authorization flow.
func (c *AppClient) AuthorizationURL(state string) string {
	query := url.Values{"client_id": []string{c.oauthID}, "state": []string{state}}
	return c.webBase + "/login/oauth/authorize?" + query.Encode()
}

// InstallationAccount is the authoritative provider view of an installation.
type InstallationAccount struct {
	ExternalID          int64
	AccountLogin        string
	AccountType         string
	AppSlug             string
	RepositorySelection string
	Suspended           bool
}

// Installation reads and validates one installation using an app JWT.
func (c *AppClient) Installation(ctx context.Context, externalID int64) (InstallationAccount, error) {
	if externalID <= 0 {
		return InstallationAccount{}, ErrInstallationNotFound
	}
	assertion, err := c.credentials.JWT()
	if err != nil {
		return InstallationAccount{}, err
	}
	body, err := c.do(ctx, http.MethodGet,
		c.apiBase+"/app/installations/"+strconv.FormatInt(externalID, 10),
		"Bearer "+assertion, nil, "",
	)
	if err != nil {
		var status *providerStatusError
		if errors.As(err, &status) && status.status == http.StatusNotFound {
			return InstallationAccount{}, ErrInstallationNotFound
		}
		return InstallationAccount{}, err
	}
	var payload struct {
		ID      int64 `json:"id"`
		Account struct {
			Login string `json:"login"`
			Type  string `json:"type"`
		} `json:"account"`
		AppSlug             string  `json:"app_slug"`
		RepositorySelection string  `json:"repository_selection"`
		SuspendedAt         *string `json:"suspended_at"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return InstallationAccount{}, errors.New("cloud scm: decode github installation")
	}
	if payload.ID != externalID || strings.TrimSpace(payload.Account.Login) == "" {
		return InstallationAccount{}, ErrInstallationNotFound
	}
	return InstallationAccount{
		ExternalID: payload.ID, AccountLogin: strings.TrimSpace(payload.Account.Login),
		AccountType:         normalizeAccountType(payload.Account.Type),
		AppSlug:             valueOr(payload.AppSlug, c.credentials.Slug()),
		RepositorySelection: normalizeRepositorySelection(payload.RepositorySelection),
		Suspended:           payload.SuspendedAt != nil,
	}, nil
}

// RepositoryRef is one repository visible to an installation.
type RepositoryRef struct {
	ExternalID int64
	FullName   string
	Private    bool
}

// ListInstallationRepositories uses a fresh internal metadata token and zeroes it.
func (c *AppClient) ListInstallationRepositories(ctx context.Context, externalID int64) ([]RepositoryRef, error) {
	if externalID <= 0 {
		return nil, ErrInstallationNotFound
	}
	token, _, err := c.mint(ctx, externalID, nil, map[string]string{"metadata": "read"})
	if err != nil {
		return nil, err
	}
	defer zeroBytes(token)
	result := make([]RepositoryRef, 0, repositoryPageSize)
	for page := 1; page <= maxRepositoryPages; page++ {
		body, listErr := c.doWithToken(ctx, http.MethodGet, fmt.Sprintf(
			"%s/installation/repositories?per_page=%d&page=%d",
			c.apiBase, repositoryPageSize, page,
		), token, nil, "")
		if listErr != nil {
			return nil, listErr
		}
		var payload struct {
			Repositories []struct {
				ID       int64  `json:"id"`
				FullName string `json:"full_name"`
				Private  bool   `json:"private"`
			} `json:"repositories"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return nil, errors.New("cloud scm: decode github installation repositories")
		}
		for _, repository := range payload.Repositories {
			fullName, normErr := NormalizeRepository(repository.FullName)
			if normErr != nil || repository.ID <= 0 {
				continue
			}
			result = append(result, RepositoryRef{
				ExternalID: repository.ID, FullName: fullName, Private: repository.Private,
			})
		}
		if len(payload.Repositories) < repositoryPageSize {
			return result, nil
		}
	}
	return nil, errors.New("cloud scm: github repository pagination limit exceeded")
}

// MintInstallationToken satisfies InstallationTokenMinter with one repository id.
func (c *AppClient) MintInstallationToken(
	ctx context.Context,
	externalInstallationID, externalRepositoryID int64,
	permissions map[string]string,
) ([]byte, time.Time, error) {
	if externalRepositoryID <= 0 {
		return nil, time.Time{}, ErrInvalidRepository
	}
	return c.mint(ctx, externalInstallationID, []int64{externalRepositoryID}, permissions)
}

func (c *AppClient) mint(
	ctx context.Context,
	externalInstallationID int64,
	repositoryIDs []int64,
	permissions map[string]string,
) ([]byte, time.Time, error) {
	if externalInstallationID <= 0 || len(permissions) == 0 {
		return nil, time.Time{}, ErrInstallationNotFound
	}
	assertion, err := c.credentials.JWT()
	if err != nil {
		return nil, time.Time{}, err
	}
	payload := map[string]any{"permissions": permissions}
	if len(repositoryIDs) != 0 {
		payload["repository_ids"] = repositoryIDs
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, time.Time{}, err
	}
	body, err := c.do(ctx, http.MethodPost,
		c.apiBase+"/app/installations/"+strconv.FormatInt(externalInstallationID, 10)+"/access_tokens",
		"Bearer "+assertion, encoded, "application/json",
	)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer zeroBytes(body)
	var response struct {
		Token     secretJSONBytes `json:"token"`
		ExpiresAt time.Time       `json:"expires_at"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, time.Time{}, errors.New("cloud scm: decode github installation token")
	}
	token := []byte(response.Token)
	response.Token = nil
	if !validInstallationToken(token) || !response.ExpiresAt.After(time.Now().UTC()) {
		zeroBytes(token)
		return nil, time.Time{}, errors.New("cloud scm: github returned an unusable installation token")
	}
	return token, response.ExpiresAt.UTC(), nil
}

// VerifyUserInstallation proves the callback user can see the installation.
func (c *AppClient) VerifyUserInstallation(ctx context.Context, code string, externalID int64) error {
	if !c.RequiresUserAuthorization() || strings.TrimSpace(code) == "" || externalID <= 0 {
		return ErrInstallationNotOwned
	}
	form := url.Values{
		"client_id":     []string{c.oauthID},
		"client_secret": []string{c.oauthSecret},
		"code":          []string{strings.TrimSpace(code)},
	}
	body, err := c.do(ctx, http.MethodPost, c.webBase+"/login/oauth/access_token", "",
		[]byte(form.Encode()), "application/x-www-form-urlencoded",
	)
	if err != nil {
		return err
	}
	defer zeroBytes(body)
	var exchange struct {
		AccessToken secretJSONBytes `json:"access_token"`
	}
	if err := json.Unmarshal(body, &exchange); err != nil || !validGitHubUserToken(exchange.AccessToken) {
		return ErrInstallationNotOwned
	}
	token := []byte(exchange.AccessToken)
	exchange.AccessToken = nil
	defer zeroBytes(token)
	for page := 1; page <= maxRepositoryPages; page++ {
		payload, listErr := c.doWithToken(ctx, http.MethodGet, fmt.Sprintf(
			"%s/user/installations?per_page=%d&page=%d", c.apiBase, repositoryPageSize, page,
		), token, nil, "")
		if listErr != nil {
			return listErr
		}
		var installations struct {
			Installations []struct {
				ID int64 `json:"id"`
			} `json:"installations"`
		}
		if err := json.Unmarshal(payload, &installations); err != nil {
			return errors.New("cloud scm: decode github user installations")
		}
		for _, installation := range installations.Installations {
			if installation.ID == externalID {
				return nil
			}
		}
		if len(installations.Installations) < repositoryPageSize {
			break
		}
	}
	return ErrInstallationNotOwned
}

// secretJSONBytes decodes a bounded unescaped JSON string directly into
// mutable storage. GitHub tokens are ASCII and never require JSON escapes.
type secretJSONBytes []byte

func (value *secretJSONBytes) UnmarshalJSON(encoded []byte) error {
	if len(encoded) < 2 || len(encoded) > maxInstallationTokenBytes+2 || encoded[0] != '"' || encoded[len(encoded)-1] != '"' {
		return errors.New("cloud scm: secret token JSON value is invalid")
	}
	decoded := encoded[1 : len(encoded)-1]
	for _, character := range decoded {
		if character < 0x21 || character > 0x7e || character == '\\' || character == '"' {
			return errors.New("cloud scm: secret token JSON value is invalid")
		}
	}
	*value = append((*value)[:0], decoded...)
	return nil
}

func validGitHubUserToken(token []byte) bool {
	if len(token) <= 4 || len(token) > maxInstallationTokenBytes ||
		(!bytes.HasPrefix(token, []byte("gho_")) && !bytes.HasPrefix(token, []byte("ghu_"))) {
		return false
	}
	for _, character := range token[4:] {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') {
			return false
		}
	}
	return true
}

type providerStatusError struct{ status int }

func (e *providerStatusError) Error() string {
	return fmt.Sprintf("cloud scm: github rejected request with status %d", e.status)
}

func (c *AppClient) do(
	ctx context.Context,
	method, target, authorization string,
	body []byte,
	contentType string,
) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", githubAcceptHeader)
	request.Header.Set("X-GitHub-Api-Version", githubAPIVersion)
	request.Header.Set("User-Agent", githubUserAgent)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("cloud scm: github request failed: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	limited := io.LimitReader(response.Body, maxProviderResponseBytes+1)
	payload, err := io.ReadAll(limited)
	if err != nil {
		return nil, errors.New("cloud scm: read github response")
	}
	if len(payload) > maxProviderResponseBytes {
		return nil, errors.New("cloud scm: github response is too large")
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, errors.Join(ErrProviderRejected, &providerStatusError{status: response.StatusCode})
	}
	return payload, nil
}

func (c *AppClient) doWithToken(
	ctx context.Context,
	method, target string,
	token, body []byte,
	contentType string,
) ([]byte, error) {
	// net/http requires an immutable header string. Keep that unavoidable copy
	// local to one request rather than retaining it across pagination.
	authorization := "Bearer " + string(token)
	return c.do(ctx, method, target, authorization, body, contentType)
}

func normalizeProviderBase(raw, fallback string) (string, error) {
	value := strings.TrimRight(valueOr(raw, fallback), "/")
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("base URL is invalid")
	}
	if parsed.Scheme != "https" && (parsed.Scheme != "http" || !isLoopbackHost(parsed.Hostname())) {
		return "", errors.New("base URL must use HTTPS")
	}
	return value, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func normalizeAccountType(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "user") {
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

func valueOr(value, fallback string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return fallback
}
