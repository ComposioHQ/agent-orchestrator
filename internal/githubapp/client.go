package githubapp

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
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
	defaultAPIBaseURL = "https://api.github.com"
	defaultWebBaseURL = "https://github.com"
	maxResponseBytes  = 8 << 20
)

type Config struct {
	AppID         int64
	AppSlug       string
	ClientID      string
	ClientSecret  string
	PrivateKeyPEM string
	PublicURL     string
	APIBaseURL    string
	WebBaseURL    string
}

type Client struct {
	appID        int64
	appSlug      string
	clientID     string
	clientSecret string
	privateKey   *rsa.PrivateKey
	publicURL    string
	apiBaseURL   string
	webBaseURL   string
	httpClient   *http.Client
	now          func() time.Time
}

type HTTPError struct {
	StatusCode int
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("GitHub request returned status %d", e.StatusCode)
}

type Installation struct {
	ID                  int64             `json:"id"`
	Account             InstallationOwner `json:"account"`
	RepositorySelection string            `json:"repository_selection"`
	Permissions         map[string]string `json:"permissions"`
	Events              []string          `json:"events"`
	SuspendedAt         *time.Time        `json:"suspended_at"`
}

type InstallationOwner struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Type  string `json:"type"`
}

type Repository struct {
	ID            int64           `json:"id"`
	Owner         RepositoryOwner `json:"owner"`
	Name          string          `json:"name"`
	FullName      string          `json:"full_name"`
	HTMLURL       string          `json:"html_url"`
	CloneURL      string          `json:"clone_url"`
	SSHURL        string          `json:"ssh_url"`
	DefaultBranch string          `json:"default_branch"`
	Visibility    string          `json:"visibility"`
	Private       bool            `json:"private"`
	Archived      bool            `json:"archived"`
	Disabled      bool            `json:"disabled"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

type RepositoryOwner struct {
	ID int64 `json:"id"`
}

func InstallationSupportsAuthorityProof(installation Installation) bool {
	switch installation.Account.Type {
	case "User":
		return true
	case "Organization":
		permission := installation.Permissions["members"]
		return permission == "read" || permission == "write"
	default:
		return false
	}
}

func New(config Config, httpClient *http.Client) (*Client, error) {
	if config.AppID <= 0 || strings.TrimSpace(config.AppSlug) == "" ||
		strings.TrimSpace(config.ClientID) == "" || config.ClientSecret == "" ||
		strings.TrimSpace(config.PublicURL) == "" {
		return nil, errors.New("GitHub App configuration is incomplete")
	}
	privateKey, err := parsePrivateKey(config.PrivateKeyPEM)
	if err != nil {
		return nil, err
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	apiBaseURL := strings.TrimRight(config.APIBaseURL, "/")
	if apiBaseURL == "" {
		apiBaseURL = defaultAPIBaseURL
	}
	webBaseURL := strings.TrimRight(config.WebBaseURL, "/")
	if webBaseURL == "" {
		webBaseURL = defaultWebBaseURL
	}
	return &Client{
		appID:        config.AppID,
		appSlug:      strings.TrimSpace(config.AppSlug),
		clientID:     strings.TrimSpace(config.ClientID),
		clientSecret: config.ClientSecret,
		privateKey:   privateKey,
		publicURL:    strings.TrimRight(config.PublicURL, "/"),
		apiBaseURL:   apiBaseURL,
		webBaseURL:   webBaseURL,
		httpClient:   httpClient,
		now:          time.Now,
	}, nil
}

func (c *Client) InstallationURL(state string) string {
	query := url.Values{"state": {state}}
	return c.webBaseURL + "/apps/" + url.PathEscape(c.appSlug) +
		"/installations/new?" + query.Encode()
}

func (c *Client) OAuthURL(state, challenge string) string {
	query := url.Values{
		"client_id":             {c.clientID},
		"redirect_uri":          {c.OAuthCallbackURL()},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	return c.webBaseURL + "/login/oauth/authorize?" + query.Encode()
}

func (c *Client) SetupCallbackURL() string {
	return c.publicURL + "/api/cloud/v1/github/install/setup"
}

func (c *Client) OAuthCallbackURL() string {
	return c.publicURL + "/api/cloud/v1/github/oauth/callback"
}

func (c *Client) GetInstallation(ctx context.Context, installationID int64) (Installation, error) {
	var installation Installation
	err := c.appJSON(ctx, http.MethodGet, "/app/installations/"+strconv.FormatInt(installationID, 10), nil, &installation)
	return installation, err
}

func (c *Client) ExchangeOAuthCode(ctx context.Context, code, verifier string) (string, error) {
	payload := map[string]string{
		"client_id":     c.clientID,
		"client_secret": c.clientSecret,
		"code":          code,
		"redirect_uri":  c.OAuthCallbackURL(),
		"code_verifier": verifier,
	}
	var response struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := c.jsonRequest(
		ctx,
		http.MethodPost,
		c.webBaseURL+"/login/oauth/access_token",
		"",
		payload,
		&response,
	); err != nil {
		return "", err
	}
	if response.Error != "" || response.AccessToken == "" {
		return "", errors.New("GitHub OAuth exchange was rejected")
	}
	return response.AccessToken, nil
}

func (c *Client) UserHasInstallation(ctx context.Context, accessToken string, installationID int64) (bool, error) {
	for page := 1; page <= 20; page++ {
		var response struct {
			Installations []Installation `json:"installations"`
		}
		path := fmt.Sprintf("/user/installations?per_page=100&page=%d", page)
		if err := c.userJSON(ctx, accessToken, http.MethodGet, path, nil, &response); err != nil {
			return false, err
		}
		for _, installation := range response.Installations {
			if installation.ID == installationID {
				return true, nil
			}
		}
		if len(response.Installations) < 100 {
			return false, nil
		}
	}
	return false, errors.New("GitHub user installation pagination exceeded limit")
}

func (c *Client) UserCanAdministerInstallation(
	ctx context.Context,
	accessToken string,
	installation Installation,
) (bool, error) {
	var user struct {
		ID int64 `json:"id"`
	}
	if err := c.userJSON(
		ctx,
		accessToken,
		http.MethodGet,
		"/user",
		nil,
		&user,
	); err != nil {
		return false, err
	}
	switch installation.Account.Type {
	case "User":
		return user.ID == installation.Account.ID, nil
	case "Organization":
		var membership struct {
			State string `json:"state"`
			Role  string `json:"role"`
		}
		path := "/user/memberships/orgs/" + url.PathEscape(installation.Account.Login)
		if err := c.userJSON(
			ctx,
			accessToken,
			http.MethodGet,
			path,
			nil,
			&membership,
		); err != nil {
			return false, err
		}
		return membership.State == "active" && membership.Role == "admin", nil
	default:
		// Enterprise installation administration requires a separate enterprise
		// role proof, so it is denied until that proof is implemented.
		return false, nil
	}
}

func (c *Client) ListRepositories(ctx context.Context, installationID int64) ([]Repository, error) {
	token, err := c.installationToken(ctx, installationID)
	if err != nil {
		return nil, err
	}
	var repositories []Repository
	for page := 1; page <= 100; page++ {
		var response struct {
			Repositories []Repository `json:"repositories"`
		}
		path := fmt.Sprintf("/installation/repositories?per_page=100&page=%d", page)
		if err := c.userJSON(ctx, token, http.MethodGet, path, nil, &response); err != nil {
			return nil, err
		}
		repositories = append(repositories, response.Repositories...)
		if len(response.Repositories) < 100 {
			return repositories, nil
		}
	}
	return nil, errors.New("GitHub repository pagination exceeded limit")
}

func (c *Client) installationToken(ctx context.Context, installationID int64) (string, error) {
	var response struct {
		Token string `json:"token"`
	}
	path := fmt.Sprintf("/app/installations/%d/access_tokens", installationID)
	if err := c.appJSON(ctx, http.MethodPost, path, map[string]any{}, &response); err != nil {
		return "", err
	}
	if response.Token == "" {
		return "", errors.New("GitHub returned an empty installation token")
	}
	return response.Token, nil
}

func (c *Client) appJSON(ctx context.Context, method, path string, body, destination any) error {
	token, err := c.appJWT()
	if err != nil {
		return err
	}
	return c.jsonRequest(ctx, method, c.apiBaseURL+path, "Bearer "+token, body, destination)
}

func (c *Client) userJSON(ctx context.Context, token, method, path string, body, destination any) error {
	return c.jsonRequest(ctx, method, c.apiBaseURL+path, "Bearer "+token, body, destination)
}

func (c *Client) jsonRequest(
	ctx context.Context,
	method, endpoint, authorization string,
	body, destination any,
) error {
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, requestBody)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("GitHub request: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxResponseBytes {
		return errors.New("GitHub response exceeded size limit")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &HTTPError{StatusCode: response.StatusCode}
	}
	if destination == nil {
		return nil
	}
	if err := json.Unmarshal(raw, destination); err != nil {
		return errors.New("GitHub returned invalid JSON")
	}
	return nil
}

func (c *Client) appJWT() (string, error) {
	now := c.now().UTC()
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	payload, _ := json.Marshal(map[string]any{
		"iat": now.Add(-60 * time.Second).Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
		"iss": c.appID,
	})
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, c.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func parsePrivateKey(value string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		return nil, errors.New("GitHub App private key is not PEM")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("GitHub App private key is invalid")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("GitHub App private key must be RSA")
	}
	return key, nil
}
